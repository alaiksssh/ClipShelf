import { t } from './i18n.js';
// How audio is painted inside a timeline piece, the way editing software does: a solid waveform,
// sharp to the screen pixel, one row per channel, detailed when zoomed in.
// Every style draws only the visible part.

const MAX_BOOST = 14; // A nearly silent track must not look loud.
const HEADROOM = 0.94;
const MIP_FACTOR = 4;

export function decode(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function hexToRgb(hex) {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

export function rgba(hex, alpha) {
  return `rgba(${hexToRgb(hex).join(',')},${alpha})`;
}

/** Opaque blend of two colours; `amount` is the share of the first one. */
export function mix(first, second, amount) {
  const b = hexToRgb(second);
  return `rgb(${hexToRgb(first).map((v, i) => Math.round(v * amount + b[i] * (1 - amount))).join(',')})`;
}

function spectrumImage(levels, columns, bands, color) {
  const canvas = document.createElement('canvas');
  canvas.width = columns;
  canvas.height = bands;
  const context = canvas.getContext('2d');
  const image = context.createImageData(columns, bands);
  const tint = hexToRgb(color);

  // Transparent, then the track colour, then close to white.
  const palette = Array.from({ length: 256 }, (_, i) => {
    const level = (i / 255) ** 1.5;
    const white = Math.max(0, (level - 0.6) / 0.4) * 0.75;
    return [...tint.map((v) => v + (255 - v) * white), 255 * Math.min(1, level * 1.5)];
  });
  for (let band = 0; band < bands; band += 1) {
    const row = band * columns;
    const line = (bands - 1 - band) * columns;
    for (let x = 0; x < columns; x += 1) {
      // Light smoothing in time, against stripes.
      const value = (levels[row + Math.max(0, x - 1)] + 2 * levels[row + x] + levels[row + Math.min(columns - 1, x + 1)]) / 4;
      image.data.set(palette[Math.round(value)], (line + x) * 4);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Coarser copies of the waveform, so that drawing a long recording costs a screen width only. */
function buildMips(base, channels) {
  const stride = channels * 2;
  const levels = [{ data: base, size: 1 }];
  while (levels.at(-1).data.length / stride > 2000) {
    const { data, size } = levels.at(-1);
    const count = data.length / stride;
    const next = new Int8Array(Math.ceil(count / MIP_FACTOR) * stride);
    for (let c = 0; c < count; c += 1) {
      const to = Math.floor(c / MIP_FACTOR) * stride;
      const first = c % MIP_FACTOR === 0;
      for (let k = 0; k < stride; k += 2) {
        const low = data[c * stride + k];
        const high = data[c * stride + k + 1];
        if (first || low < next[to + k]) next[to + k] = low;
        if (first || high > next[to + k + 1]) next[to + k + 1] = high;
      }
    }
    levels.push({ data: next, size: size * MIP_FACTOR });
  }
  return levels;
}

/** Prepares what the painters need for one track. */
export function prepareTrack(info, analysis, color) {
  const { columns, spectrumColumns, bands, duration } = analysis;
  return {
    color,
    duration,
    channels: info.channels,
    perSecond: columns / duration,
    gain: (info.peak / 127) * Math.min(MAX_BOOST, HEADROOM / Math.max(info.loud, 1e-6)),
    mips: buildMips(new Int8Array(decode(info.wave).buffer), info.channels),
    image: spectrumImage(decode(info.spectrum), spectrumColumns, bands, color),
  };
}

/** Lowest and highest sample of a channel between two source times, written into `out`. */
function extremes(track, channel, from, to, out) {
  const { mips, channels, perSecond } = track;
  const stride = channels * 2;
  const offset = channel * 2;
  const first = from * perSecond;
  const last = to * perSecond;
  const span = last - first;

  if (span < 1) {
    // Closer than the resolution: interpolate, or the zoomed wave would turn into steps.
    const { data } = mips[0];
    const count = data.length / stride;
    const middle = Math.max(0, (first + last) / 2 - 0.5);
    const a = Math.min(count - 1, Math.floor(middle));
    const b = Math.min(count - 1, a + 1);
    const t = middle - Math.floor(middle);
    out[0] = data[a * stride + offset] * (1 - t) + data[b * stride + offset] * t;
    out[1] = data[a * stride + offset + 1] * (1 - t) + data[b * stride + offset + 1] * t;
    return;
  }
  let level = 0;
  while (level < mips.length - 1 && mips[level + 1].size <= span) level += 1;
  const { data, size } = mips[level];
  const count = data.length / stride;
  const start = Math.min(count - 1, Math.max(0, Math.floor(first / size)));
  const end = Math.min(count, Math.max(start + 1, Math.round(last / size)));
  let low = 127;
  let high = -127;
  for (let c = start; c < end; c += 1) {
    const at = c * stride + offset;
    if (data[at] < low) low = data[at];
    if (data[at + 1] > high) high = data[at + 1];
  }
  out[0] = low;
  out[1] = high;
}

/** Calls `visit` once per screen pixel, anchored to the piece so that scrolling does not shimmer. */
function eachPixel({ x, left, right, from, perPixel, ratio }, visit) {
  const step = 1 / ratio;
  for (let i = Math.max(0, Math.floor((left - x) * ratio)); x + i * step < right; i += 1) {
    const start = from + i * step * perPixel;
    visit(x + i * step, start, start + step * perPixel);
  }
}

function waveform(ctx, track, area) {
  const { y, h, gain, left, right, color, line, ratio } = area;
  const rows = track.channels === 2 && h >= 30 ? 2 : 1;
  const rowHeight = h / rows;
  const step = 1 / ratio;
  const out = [0, 0];
  const other = [0, 0];
  const scale = track.gain * gain;

  for (let row = 0; row < rows; row += 1) {
    const middle = Math.round((y + rowHeight * (row + 0.5)) * ratio) / ratio;
    const half = rowHeight / 2 - 1;
    const shape = new Path2D();
    eachPixel(area, (px, start, end) => {
      extremes(track, row, start, end, out);
      if (rows < track.channels) {
        extremes(track, 1, start, end, other);
        out[0] = Math.min(out[0], other[0]);
        out[1] = Math.max(out[1], other[1]);
      }
      const top = Math.max(0, Math.min(1, out[1] * scale)) * half;
      const bottom = Math.max(0, Math.min(1, -out[0] * scale)) * half;
      shape.rect(px, middle - top, step, top + bottom + step);
    });
    ctx.fillStyle = color;
    ctx.fill(shape);
    if (row) {
      ctx.fillStyle = line;
      ctx.fillRect(left, y + rowHeight * row, right - left, step);
    }
  }
}

function rectified(ctx, track, area) {
  const { y, h, gain, color, ratio } = area;
  const step = 1 / ratio;
  const out = [0, 0];
  const scale = track.gain * gain;
  const shape = new Path2D();
  eachPixel(area, (px, start, end) => {
    let top = 0;
    for (let channel = 0; channel < track.channels; channel += 1) {
      extremes(track, channel, start, end, out);
      top = Math.max(top, -out[0], out[1]);
    }
    const size = Math.min(1, top * scale) * (h - 2) + step;
    shape.rect(px, y + h - size, step, size);
  });
  ctx.fillStyle = color;
  ctx.fill(shape);
}

function spectrum(ctx, track, area) {
  const { x, y, h, left, right, from, perPixel } = area;
  const { image } = track;
  const perSecond = image.width / track.duration;
  const start = Math.max(0, (from + (left - x) * perPixel) * perSecond);
  const size = Math.min(image.width - start, (right - left) * perPixel * perSecond);
  if (size <= 0) return;
  ctx.imageSmoothingQuality = 'high';
  if (area.off) ctx.filter = 'grayscale(1) opacity(0.4)';
  ctx.drawImage(image, start, 0, size, image.height, left, y, right - left, h);
  ctx.filter = 'none';
}

export const STYLES = {
  wave: { label: t('wave.wave'), paint: waveform },
  rectified: { label: t('wave.rectified'), paint: rectified },
  spectrum: { label: t('wave.spectrum'), paint: spectrum },
};
