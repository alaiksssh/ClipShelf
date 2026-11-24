// Analyses every audio track in one pass: stereo waveform, spectrogram and default on/off state.
//
// All tracks are always shown and editable. The analysis only chooses a sensible default, because
// recorders often repeat a mix on several tracks, and playing those together multiplies the volume.
const { ffmpeg } = require('./ffmpeg');
const { Spectrogram, BANDS } = require('./spectrum');

const RATE = 16000;
const COMPARE_EVERY = 4;
const SILENT_RMS = 2;

// Waveform resolution: enough to show single gunshots and syllables when zoomed in.
const COLUMNS_PER_SECOND = 400;
const MIN_COLUMNS = 4000;
const MAX_COLUMNS = 400000;

/** The name of a track, or '' when it has none: the interface then calls it "Track 2" in its language. */
function labelOf(name) {
  // Names that recorders fill in by themselves say nothing.
  const placeholder = /^(sound ?handler|sound media handler|.*audio handler|track ?\d+|simple_\w+)$/i;
  if (!name || placeholder.test(name)) return '';
  return name.replace(/^\d+:/, '');
}

function classify(names, dot, samples) {
  const audible = (i) => Math.sqrt(dot[i][i] / Math.max(samples, 1)) >= SILENT_RMS;
  const corr = (i, j) => dot[i][j] / (Math.sqrt(dot[i][i] * dot[j][j]) || 1);
  const same = (i, j) => corr(i, j) > 0.995 && Math.abs(dot[i][i] / dot[j][j] - 1) < 0.1;
  const namedMix = /^(0:all|mix|master)$/i.test(names[0] || '');

  return names.map((name, i) => {
    const track = { index: i, label: labelOf(name), note: null, on: true };
    if (!audible(i)) return { ...track, note: { key: 'track.silent' }, on: i === 0 };
    if (i === 0) return track;

    for (let j = 0; j < i; j += 1) {
      if (audible(j) && same(j, i)) return { ...track, note: { key: 'track.sameAs', params: { n: j + 1 } }, on: false };
    }
    // If track i is part of track 1, projecting track 1 onto it gives a gain close to 1,
    // however quiet that part is.
    const gain = dot[0][i] / dot[i][i];
    if (namedMix || (corr(0, i) > 0.04 && gain > 0.7 && gain < 1.3)) {
      return { ...track, note: { key: 'track.inFirst' }, on: false };
    }
    return track;
  });
}

/**
 * Packs [minL, maxL, minR, maxR] per column (or [min, max] for mono) into signed bytes,
 * relative to the loudest sample, so that a quiet microphone keeps its detail.
 */
function packWave(extremes, columns) {
  let peak = 1;
  let mono = true;
  for (let i = 0; i < extremes.length; i += 4) {
    peak = Math.max(peak, -extremes[i], extremes[i + 1], -extremes[i + 2], extremes[i + 3]);
    if (mono && (Math.abs(extremes[i] - extremes[i + 2]) > 2 || Math.abs(extremes[i + 1] - extremes[i + 3]) > 2)) {
      mono = false;
    }
  }
  const channels = mono ? 1 : 2;
  const bytes = new Int8Array(columns * channels * 2);
  const highs = new Float32Array(columns);
  for (let c = 0; c < columns; c += 1) {
    for (let k = 0; k < channels * 2; k += 1) {
      const value = extremes[c * 4 + k];
      bytes[c * channels * 2 + k] = Math.round((value / peak) * 127);
      highs[c] = Math.max(highs[c], Math.abs(value));
    }
  }
  highs.sort();
  return {
    channels,
    peak: peak / 32768,
    // What fills the height of a lane: a rare spike must not flatten everything else.
    loud: highs[Math.floor(columns * 0.999)] / 32768,
    wave: Buffer.from(bytes.buffer).toString('base64'),
  };
}

async function analyse(file, info) {
  const n = info.audio.length;
  if (!n) return { columns: 0, spectrumColumns: 0, bands: BANDS, tracks: [] };

  const columns = Math.round(Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, info.duration * COLUMNS_PER_SECOND)));
  const spectrumColumns = Math.round(Math.min(4000, Math.max(1000, info.duration * 30)));
  const total = Math.max(1, info.duration * RATE);
  const inputs = info.audio.map((_, i) =>
    `[0:a:${i}]aresample=${RATE}:async=1:first_pts=0,aformat=channel_layouts=stereo,apad[a${i}]`);
  const labels = info.audio.map((_, i) => `[a${i}]`).join('');
  const merge = n > 1 ? `${labels}amerge=inputs=${n}[out]` : '[a0]anull[out]';

  const frameBytes = n * 4;
  const spectra = Array.from({ length: n }, () => new Spectrogram(spectrumColumns, total, RATE));
  const extremes = Array.from({ length: n }, () => new Int16Array(columns * 4));
  const dot = Array.from({ length: n }, () => new Float64Array(n));
  const frame = new Float64Array(n);
  let rest = Buffer.alloc(0);
  let samples = 0;

  const onData = (data) => {
    const buffer = rest.length ? Buffer.concat([rest, data]) : data;
    const end = buffer.length - (buffer.length % frameBytes);
    for (let offset = 0; offset < end; offset += frameBytes) {
      const at = Math.min(columns - 1, Math.floor((samples / total) * columns)) * 4;
      for (let i = 0; i < n; i += 1) {
        const left = buffer.readInt16LE(offset + i * 4);
        const right = buffer.readInt16LE(offset + i * 4 + 2);
        const track = extremes[i];
        if (left < track[at]) track[at] = left;
        if (left > track[at + 1]) track[at + 1] = left;
        if (right < track[at + 2]) track[at + 2] = right;
        if (right > track[at + 3]) track[at + 3] = right;
        const mono = (left + right) / 2;
        frame[i] = mono;
        spectra[i].push(mono);
      }
      if (samples % COMPARE_EVERY === 0) {
        for (let i = 0; i < n; i += 1) {
          for (let j = 0; j <= i; j += 1) dot[i][j] += frame[i] * frame[j];
        }
      }
      samples += 1;
    }
    rest = buffer.subarray(end);
  };

  await ffmpeg([
    '-vn', '-i', file,
    '-filter_complex', [...inputs, merge].join(';'),
    '-map', '[out]', '-t', String(info.duration), '-f', 's16le', '-',
  ], { onData, low: true });

  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) dot[j][i] = dot[i][j];

  const tracks = classify(info.audio.map((a) => a.name), dot, samples / COMPARE_EVERY).map((track, i) => ({
    ...track,
    ...packWave(extremes[i], columns),
    spectrum: spectra[i].levels().toString('base64'),
  }));
  return { columns, spectrumColumns, bands: BANDS, tracks };
}

module.exports = { analyse, classify, labelOf };
