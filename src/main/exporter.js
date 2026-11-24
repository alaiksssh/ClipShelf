const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ffmpeg } = require('./ffmpeg');
const { t, decimal, bytes: megabytes } = require('./i18n');

const shared = Promise.all([
  import('../shared/edit.mjs'),
  import('../shared/pieces.mjs'),
  import('../shared/transitions.mjs'),
  import('../shared/geometry.mjs'),
]).then((modules) => Object.assign({}, ...modules));

const SAMPLE_RATE = 48000;
const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
const LIMITER = 'alimiter=limit=0.97:level=disabled:latency=1';
// Also keeps the command line under the Windows limit of 32767 characters.
const MAX_INPUTS = 120;
const COPYABLE = new Set(['h264', 'hevc', 'av1']);
const FRAME_RATES = [24, 25, 30, 50, 60, 75, 90, 100, 120, 144, 165, 240];

let amf;

/** True when the AMD hardware encoder works on this machine. Asked once, at start, by the main process. */
function hasAmf() {
  amf ??= ffmpeg([
    '-f', 'lavfi', '-i', 'color=s=640x360:r=30:d=0.2', '-c:v', 'h264_amf', '-f', 'null', '-',
  ]).then(() => true, () => false);
  return amf;
}

// The log under the bar speaks the language of the interface.
function seconds(value) {
  if (value < 59.95) return t('unit.seconds', { n: decimal(value) });
  const whole = Math.round(value);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The first line of the log: what is being exported. */
function describe({ model, pieces, groups, length }) {
  const parts = pieces.filter((piece) => piece.lane === model.VIDEO).length;
  const heard = groups.flat().length;
  let sound = t('export.silent');
  if (heard === 1) sound = t('export.tracks', { count: 1 });
  else if (heard > 1) sound = t(groups.length > 1 ? 'log.tracksSeparate' : 'log.tracksMixed', { count: heard });
  return t('log.montage', { length: seconds(length), count: parts, sound });
}

/** Pieces need one constant rate. Variable rate captures go up to the next standard one. */
function frameRate(fps) {
  if (!(fps > 1)) return 30;
  if (Math.abs(fps - 29.97) < 0.02) return '30000/1001';
  if (Math.abs(fps - 59.94) < 0.02) return '60000/1001';
  return FRAME_RATES.find((rate) => rate >= fps - 0.6) || 240;
}

function rateValue(rate) {
  const [num, den = 1] = String(rate).split('/').map(Number);
  return num / den;
}

/** The filter for the volume of one piece of sound, or nothing when it plays as recorded. */
function pieceVolume(volume) {
  return Math.abs(volume - 1) < 1e-3 ? '' : `volume=${Number(volume.toFixed(3))},`;
}

function atempo(speed) {
  if (speed > 2) return `atempo=2,${atempo(speed / 2)}`;
  if (speed < 0.5) return `atempo=0.5,${atempo(speed / 0.5)}`;
  return `atempo=${speed}`;
}

/**
 * Builds the inputs and filters of a montage. Each lane becomes a chain of pieces and gaps, whose
 * boundaries are rounded cumulatively, so picture and sound cannot drift whatever the cuts.
 *
 * A transition at a cut takes half its length from the file after the end of the piece before, and
 * half before the start of the piece after ("handles"): the chain is split there into segments, joined
 * by xfade (picture) or acrossfade (sound) over the length of both handles, so the montage keeps its
 * length. Where the file has no frame left for a handle, the first or last frame is held (silence on
 * a track). At an edge with nothing next to it, the piece fades from or to black, white or silence.
 */
function buildMontage(options, { video = true, size = null, fps = options.fps } = {}) {
  const { model, pieces, groups, crop, width, height, length, duration } = options;
  const ranges = [];
  const indexes = new Map();
  /** The input of a piece, `lead` and `tail` seconds of the montage wider on each side. */
  const inputOf = (piece, lead = 0, tail = 0) => {
    const from = Math.max(0, piece.from - lead * piece.speed);
    const to = Math.min(duration, piece.to + tail * piece.speed);
    // Linked pieces share an input. The position is in the key, so duplicates get their own.
    const key = [piece.at, from, to].map((v) => v.toFixed(4)).join('|');
    if (!indexes.has(key)) {
      indexes.set(key, ranges.length);
      ranges.push([from, to]);
    }
    return indexes.get(key);
  };

  const parts = [];
  let count = 0;
  const label = () => `[p${(count += 1)}]`;
  /**
   * `fromPiece(piece, units, shape, input)` gives the filters of a piece, where shape is { lead, tail,
   * missing, fadeIn, fadeOut } in units. `forGap(units)` gives a gap. `join(kind, units, firstUnits)`
   * blends two segments. Returns the label of the whole lane.
   */
  const chain = (lane, unit, fromPiece, forGap, join) => {
    const cuts = new Map(); // Id of the piece after a cut -> { kind, half, left }.
    const edges = new Map(); // Id -> { fadeIn, fadeOut }, in units.
    for (const transition of model.transitionsOf(pieces, lane)) {
      const units = Math.max(2, Math.round((transition.end - transition.start) * unit));
      if (transition.left && transition.right) {
        cuts.set(transition.right.id, { kind: transition.kind, half: Math.round(units / 2), left: transition.left.id });
      } else {
        const piece = transition.right || transition.left;
        const edge = edges.get(piece.id) || {};
        edge[transition.right ? 'fadeIn' : 'fadeOut'] = { kind: transition.kind, units };
        edges.set(piece.id, edge);
      }
    }
    const tails = new Map([...cuts.values()].map((cut) => [cut.left, cut.half]));

    const segments = [{ labels: [], units: 0 }];
    const joins = [];
    const add = (body, input, units) => {
      const out = label();
      parts.push(`${input}${body}${out}`);
      const segment = segments.at(-1);
      segment.labels.push(out);
      segment.units += units;
    };
    let cursor = 0;
    let last = null;
    for (const piece of model.onLane(pieces, lane)) {
      if (piece.muted) continue;
      const start = Math.max(cursor, Math.round(piece.at * unit));
      const end = Math.round(model.endOf(piece) * unit);
      if (end <= start) continue;
      if (start > cursor) add(forGap(start - cursor), '', start - cursor);
      const cut = cuts.get(piece.id);
      const lead = cut && last === cut.left && start === cursor ? cut.half : 0;
      if (lead) {
        joins.push({ kind: cut.kind, units: lead + tails.get(cut.left) });
        segments.push({ labels: [], units: 0 });
      }
      const tail = tails.get(piece.id) && cuts.has(nextId(piece)) ? tails.get(piece.id) : 0;
      // What the file holds before the piece, in units of the montage: the rest of the lead is held.
      const held = Math.min(lead, Math.floor((piece.from / piece.speed) * unit + 1e-6));
      const edge = edges.get(piece.id) || {};
      add(...fromPiece(piece, end - start, {
        lead, tail, missing: lead - held, fadeIn: edge.fadeIn, fadeOut: edge.fadeOut,
      }, inputOf(piece, lead / unit, tail / unit)), end - start + lead + tail);
      cursor = end;
      last = piece.id;
    }
    const total = Math.max(1, Math.round(length * unit));
    if (cursor < total) add(forGap(total - cursor), '', total - cursor);

    let current = null;
    let currentUnits = 0;
    segments.forEach((segment, i) => {
      if (!segment.labels.length) return;
      const out = label();
      parts.push(`${segment.labels.join('')}concat=n=${segment.labels.length}:${unit === SAMPLE_RATE ? 'v=0:a=1' : 'v=1:a=0'}${out}`);
      if (!current) {
        current = out;
        currentUnits = segment.units;
        return;
      }
      const blend = joins[i - 1];
      const joined = label();
      parts.push(`${current}${out}${join(blend.kind, blend.units, currentUnits)}${joined}`);
      current = joined;
      currentUnits += segment.units - blend.units;
    });
    return current;

    /** The id of the piece that follows on this lane, when it touches. */
    function nextId(piece) {
      const row = model.onLane(pieces, lane).filter((other) => !other.muted);
      const after = row[row.indexOf(piece) + 1];
      return after && Math.abs(model.endOf(piece) - after.at) < model.EPS ? after.id : null;
    }
  };

  if (video) {
    const out = size || { w: Math.floor(width / 2) * 2, h: Math.floor(height / 2) * 2 };
    const rate = rateValue(fps);
    const shape = [
      crop && `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
      `scale=${out.w}:${out.h}`, 'setsar=1', 'format=yuv420p',
    ].filter(Boolean).join(',');
    const timing = `settb=AVTB,setpts=N/(${fps})/TB`;
    const seconds = (frames) => (frames / rate).toFixed(6);
    const fade = (way, edge, first) => `,fade=t=${way}:s=${first}:n=${edge.units}:c=${edge.kind === 'white' ? 'white' : 'black'}`;
    const whole = chain(
      model.VIDEO,
      rate,
      (piece, frames, { lead, tail, missing, fadeIn, fadeOut }, input) => [
        `setpts=PTS/${piece.speed},fps=fps=${fps}:start_time=0,${shape},`
          + `tpad=${missing ? `start_mode=clone:start=${missing}:` : ''}stop_mode=clone:stop=-1,`
          + `trim=end_frame=${frames + lead + tail},${timing}`
          + (fadeIn ? fade('in', fadeIn, 0) : '')
          + (fadeOut ? fade('out', fadeOut, frames + lead + tail - fadeOut.units) : ''),
        `[${input}:v:0]`,
      ],
      (frames) => `color=c=black:s=${out.w}x${out.h}:r=${fps},trim=end_frame=${frames},setsar=1,format=yuv420p,${timing}`,
      (kind, frames, firstFrames) => `xfade=transition=${model.VIDEO_KINDS[kind] || 'fade'}`
        + `:duration=${seconds(frames)}:offset=${seconds(firstFrames - frames)},${timing}`,
    );
    parts.push(`${whole}fps=${fps}[video]`);
  }

  groups.forEach((group, g) => {
    const mixed = group.map((track, k) => {
      const afade = (way, edge, first) => `,afade=t=${way}:ss=${first}:ns=${edge.units}:curve=qsin`;
      const whole = chain(
        track.index,
        SAMPLE_RATE,
        (piece, samples, { lead, tail, missing, fadeIn, fadeOut }, input) => [
          `aresample=${SAMPLE_RATE}:async=1:first_pts=0,${AUDIO_FORMAT},${atempo(piece.speed)},`
            + `${pieceVolume(model.volumeOf(piece))}`
            + `${missing ? `adelay=delays=${((missing / SAMPLE_RATE) * 1000).toFixed(3)}:all=1,` : ''}`
            + `apad,atrim=end_sample=${samples + lead + tail},asetpts=N/SR/TB`
            + (fadeIn ? afade('in', fadeIn, 0) : '')
            + (fadeOut ? afade('out', fadeOut, samples + lead + tail - fadeOut.units) : ''),
          `[${input}:a:${track.index}]`,
        ],
        (samples) => `anullsrc=r=${SAMPLE_RATE}:cl=stereo,${AUDIO_FORMAT},atrim=end_sample=${samples},asetpts=N/SR/TB`,
        (kind, samples) => `acrossfade=ns=${samples}:c1=qsin:c2=qsin,asetpts=N/SR/TB`,
      );
      parts.push(`${whole}volume=${track.volume}[t${g}_${k}]`);
      return `[t${g}_${k}]`;
    });
    const mix = group.length > 1 ? `amix=inputs=${group.length}:normalize=0:duration=longest,` : '';
    parts.push(`${mixed.join('')}${mix}${LIMITER}[audio${g}]`);
  });

  return { graph: parts.join(';\n'), ranges, inputOf };
}

function inputArgs(clip, ranges) {
  if (ranges.length > MAX_INPUTS) throw new Error(t('log.tooCut'));
  // Relative to the clip folder, to keep the command line short.
  const file = `./${path.basename(clip.path)}`;
  return ranges.flatMap(([from, to]) => ['-ss', from.toFixed(6), '-t', (to - from).toFixed(6), '-i', file]);
}

function outputArgs(format) {
  return format === 'matroska' ? ['-f', format] : ['-movflags', '+faststart', '-f', format];
}

function audioArgs(groups, bitrate) {
  if (!groups.length) return ['-an'];
  return [
    ...groups.flatMap((_, g) => ['-map', `[audio${g}]`]),
    '-c:a', 'aac', '-b:a', `${bitrate}k`,
    ...groups.flatMap((group, g) => (group.length === 1 && group[0].name
      ? [`-metadata:s:a:${g}`, `title=${group[0].name}`, `-metadata:s:a:${g}`, `handler_name=${group[0].name}`]
      : [])),
  ];
}

/** True when the picture can be copied without loss: it plays from the very first frame, no key frame to snap to. */
function copiesWhole(clip, { model, edit, pieces }) {
  const picture = pieces.find((piece) => piece.lane === model.VIDEO);
  return model.canCopyVideo({ ...edit, pieces }) && picture.from < model.EPS && COPYABLE.has(clip.codec);
}

/** Why `copiesWhole` refused, in the words of the log. */
function notCopiedBecause(clip, { model, edit, pieces }) {
  const video = pieces.filter((piece) => piece.lane === model.VIDEO);
  if (video.length !== 1) return t('log.why.pieces');
  if (edit.ratio !== 'original') return t('log.why.cropped');
  if (video[0].speed !== 1) return t('log.why.speed');
  if (model.blendsPicture(pieces)) return t('log.why.transitions');
  if (video[0].at > model.EPS) return t('log.why.moved');
  if (!model.canCopyVideo({ ...edit, pieces })) return t('log.why.shifted');
  // A copy would start on the key frame before the cut.
  if (video[0].from >= model.EPS) return t('log.why.start');
  return t('log.why.format', { codec: clip.codec || t('log.unknown') });
}

async function prepare(clip, request) {
  const model = await shared;
  const edit = model.outputEdit(model.loadEdit(request.edit, clip));
  const audible = model.audibleTracks(edit.tracks);
  const tracks = edit.tracks
    .map((track, index) => ({ index, volume: track.volume, name: track.name || String(request.labels?.[index] || '').slice(0, 40) }))
    .filter(({ index }) => audible[index]);

  // Switched off tracks must not make the montage longer.
  const pieces = edit.pieces.filter((piece) => piece.lane === model.VIDEO || (audible[piece.lane] && !piece.muted));
  const crop = model.cropRect(clip.width, clip.height, edit.ratio, edit.position);
  let mode = ['quality', 'size', 'copy', 'discord'].includes(request.mode) ? request.mode : 'quality';
  if (request.mode === 'auto') mode = copiesWhole(clip, { model, edit, pieces }) ? 'copy' : 'quality';
  return {
    model,
    edit,
    pieces,
    crop,
    width: crop?.w ?? clip.width,
    height: crop?.h ?? clip.height,
    fps: frameRate(clip.fps),
    length: model.totalLength(pieces),
    duration: clip.duration,
    groups: request.separate ? tracks.map((track) => [track]) : tracks.length ? [tracks] : [],
    mode,
    targetMB: Number(request.targetMB),
  };
}

/** Copies the video stream; only the sound is encoded. */
async function encodeCopy({ clip, options, run, out, writeGraph, log }) {
  const { model, pieces, groups, edit } = options;
  if (!model.canCopyVideo({ ...edit, pieces })) {
    throw new Error(t('log.copyNeeds'));
  }
  const picture = pieces.find((piece) => piece.lane === model.VIDEO);
  const { graph, ranges, inputOf } = buildMontage(options, { video: false });
  const input = inputOf(picture);
  log(t('log.copy'));
  await run([
    ...inputArgs(clip, ranges),
    ...(graph ? ['-filter_complex_script', await writeGraph(graph)] : []),
    '-map', `${input}:v:0`, ...audioArgs(groups, 192),
    '-c:v', 'copy', ...outputArgs(options.format), '-y', out,
  ]);
}

/** Encodes at the size and rate of the clip, on the AMD encoder when there is one. */
async function encodeAtQuality({ clip, options, run, out, writeGraph, signal, log }, { amf, x264, audio }) {
  const { graph, ranges } = buildMontage(options);
  const script = await writeGraph(graph);
  const encode = (codec) => run([
    ...inputArgs(clip, ranges), '-filter_complex_script', script,
    '-map', '[video]', ...audioArgs(options.groups, audio),
    ...codec, ...outputArgs(options.format), '-y', out,
  ]);
  if (await hasAmf()) {
    try {
      log(t('log.amf'));
      await encode(amf);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error('AMF failed, falling back to x264:', error.message);
      log(t('log.amfFailed'));
      await encode(x264);
      return;
    }
  }
  log(t('log.x264'));
  await encode(x264);
}

// The "speed" preset of the AMD encoder, measured on 1080p75 OBS clips: 1.5 times faster than
// "quality", 2 % heavier, the same SSIM against the original (0.980). The encoder is what limits an
// export: decoding takes less than half the time, and encoding in parallel pieces gains nothing.
function encodeQuality(context) {
  return encodeAtQuality(context, {
    amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '21', '-qp_b', '23'],
    x264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
    audio: 192,
  });
}

/**
 * For Discord: the picture of the clip intact when that fits under the limit, copied when the montage
 * allows it, else encoded as a normal export does; squeezed down to the limit otherwise. The user has
 * Nitro and wants the quality of the clip kept, not a light compression.
 */
async function encodeDiscord(context) {
  const { clip, options, out, log } = context;
  if (!(options.targetMB >= 1 && options.targetMB <= 4000)) throw new Error(t('log.badTarget'));
  const limit = options.targetMB * 1e6;
  const copy = copiesWhole(clip, options);
  if (!copy) log(t('log.reencoded', { why: notCopiedBecause(clip, options) }));
  // Measured on 1080p 75 fps OBS clips: a copy keeps the weight of what OBS records, the encode of a
  // normal export makes it about a quarter heavier. When that is far over the limit, trying it first
  // would only double the wait.
  const guess = (clip.size / clip.duration) * options.length * (copy ? 1 : 1.25);
  if (!(guess > limit * 1.25)) {
    await (copy ? encodeCopy(context) : encodeQuality(context));
    const { size } = await fs.stat(out);
    if (size <= limit) return;
    log(t('log.overRetry', { size: megabytes(size), mb: options.targetMB }));
  } else {
    log(t('log.overGuess', { size: megabytes(guess), mb: options.targetMB }));
  }
  await encodeSize(context);
}

/**
 * Two-pass encode that stays under a size limit. The "faster" preset of x264, measured on 1080p
 * clips at 6 Mbit/s: a fifth faster than "fast" for an SSIM of 0.992 instead of 0.9925. The AMD
 * encoder in one pass would take a third of the time, but falls to 0.985 at the same size.
 */
async function encodeSize({ clip, options, run, out, writeGraph, workDir, log }) {
  const { length, groups, targetMB, width, height, fps } = options;
  if (!(targetMB >= 1 && targetMB <= 4000)) throw new Error(t('log.badTarget'));
  const limit = targetMB * 1e6;
  const budget = (limit * 8 * 0.95) / length / 1000; // kbit/s
  const audio = budget < 900 ? 64 : 128;
  let video = Math.min(budget - audio * groups.length, 40000);
  if (video < 120) throw new Error(t('log.tooLong'));

  const shortSide = Math.min(width, height);
  const wanted = video >= 5000 ? 1080 : video >= 1800 ? 720 : video >= 700 ? 480 : 360;
  const scale = Math.min(1, wanted / shortSide);
  const rate = rateValue(fps);
  const frame = { w: Math.round((width * scale) / 2) * 2, h: Math.round((height * scale) / 2) * 2 };
  const outRate = video < 1800 && rate > 31 ? 30 : rate > 61 ? 60 : fps;
  const { graph, ranges } = buildMontage(options, { size: frame, fps: outRate });
  const script = await writeGraph(graph);
  log(t('log.sizeMode', {
    mb: targetMB, w: frame.w, h: frame.h, fps: Math.round(rateValue(outRate)), kbps: Math.floor(video),
  }));

  const passLog = path.join(workDir, 'pass');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const common = [
      ...inputArgs(clip, ranges), '-filter_complex_script', script,
      '-map', '[video]', ...audioArgs(groups, audio),
      '-c:v', 'libx264', '-preset', 'faster', '-b:v', `${Math.floor(video)}k`, '-passlogfile', passLog,
    ];
    log(t('log.pass1'));
    await run([...common, '-pass', '1', '-f', 'null', '-'], [0, 0.4]);
    log(t('log.pass2'));
    await run([...common, '-pass', '2', ...outputArgs(options.format), '-y', out], [0.4, 1]);
    const { size } = await fs.stat(out);
    if (size <= limit) return;
    video *= (limit / size) * 0.92;
    log(t('log.overRetryAt', { size: megabytes(size), mb: targetMB, kbps: Math.floor(video) }));
  }
  throw new Error(t('log.cannotFit'));
}

const ENCODERS = { copy: encodeCopy, quality: encodeQuality, size: encodeSize, discord: encodeDiscord };

/**
 * Encodes into a temporary folder, then copies to a free name: never replaces an existing file.
 * With `save`, the caller decides what becomes of the encoded file.
 */
async function exportClip(clip, request, {
  outDir, signal, onProgress = () => {}, onLog = () => {}, format = 'mp4', save,
}) {
  const options = { ...(await prepare(clip, request)), format };
  // Each step is a line of the log. While ffmpeg runs, that line also tells how far it is.
  let step = '';
  const log = (text) => {
    step = text;
    onLog(text);
  };
  log(describe(options));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipshelf-'));
  const out = path.join(workDir, format === 'matroska' ? 'out.mkv' : 'out.mp4');

  const writeGraph = async (graph) => {
    const file = path.join(workDir, 'graph.txt');
    await fs.writeFile(file, graph);
    return file;
  };
  const run = (args, [from, to] = [0, 1]) => ffmpeg(['-progress', 'pipe:1', '-nostats', ...args], {
    cwd: path.dirname(clip.path),
    signal,
    low: true,
    onData: (data) => {
      const text = String(data);
      const time = text.match(/out_time_us=(\d+)/);
      if (!time) return;
      const done = Math.min(options.length, Number(time[1]) / 1e6);
      onProgress(from + (to - from) * Math.min(1, done / options.length));
      // How many times faster than playback, once ffmpeg knows it.
      const speed = text.match(/speed=\s*([\d.]+)x/);
      const pace = speed ? `, ×${decimal(speed[1])}` : '';
      onLog(t('log.live', { step, done: seconds(done), length: seconds(options.length), pace }), true);
    },
  });

  try {
    await ENCODERS[options.mode]({ clip, options, run, out, writeGraph, workDir, signal, log });
    log(t('log.encoded', { size: megabytes((await fs.stat(out)).size) }));
    if (save) return await save(out, options);
    log(t('log.toExports'));
    await fs.mkdir(outDir, { recursive: true });
    for (let n = 1; ; n += 1) {
      const target = path.join(outDir, `${clip.name} - edit${n > 1 ? ` ${n}` : ''}.mp4`);
      try {
        // On the same disk, a link: nothing to copy. It fails, like the copy, on a name already taken.
        await fs.link(out, target).catch((error) => {
          if (error.code === 'EEXIST') throw error;
          return fs.copyFile(out, target, constants.COPYFILE_EXCL);
        });
        return { path: target, size: (await fs.stat(target)).size };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

module.exports = { exportClip, hasAmf };
