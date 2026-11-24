// Paints the timeline lanes. Coordinates are pixels of the visible part of a lane.
import { cssColor } from './dom.js';
import { ICONS } from './icons.js';
import * as format from './format.js';
import { STYLES, rgba, mix } from './waveforms.js';
import { VIDEO, endOf, lengthOf, sourceAt, volumeOf } from '/shared/pieces.mjs';
import { t } from './i18n.js';

export const TRACK_COLORS = ['cpu', 'ram', 'net', 'disk', 'ok', 'warn', 'charge', 'gpu', 'low'];
export const EDGE = 10; // Grab area of a trim handle.

const INSET = 2;
const RADIUS = 6;
const STRIP = 16; // Name strip on top of each piece.
const CORNER = 8; // Mark of an edge that has something to give back.
const SEAM = { height: 22, icon: 11, padding: 7, gap: 4 };
const TILE = 92;
const TICKS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const LABEL_SPACE = 76;
const ICON_PATH = {};

function drawIcon(ctx, name, x, y, size) {
  ICON_PATH[name] ??= new Path2D(ICONS[name]);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 256, size / 256);
  ctx.fill(ICON_PATH[name]);
  ctx.restore();
}

/** Sizes a canvas for the screen density and returns a cleared context in CSS pixels. */
export function prepareCanvas(canvas, width, height) {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export class Painter {
  constructor(clip, requestDraw) {
    this.clip = clip;
    this.requestDraw = requestDraw;
    this.film = new Map();
    this.tracks = [];
    const names = ['accent', 'text', 'dim', 'bg', 'off', 'low'];
    this.colors = Object.fromEntries(names.map((name) => [name, cssColor(name)]));
    this.trackColors = TRACK_COLORS.map(cssColor);
    this.font = cssColor('font');
  }

  colorOf(lane) {
    return lane === VIDEO ? this.colors.accent : this.trackColors[lane % this.trackColors.length];
  }

  frame(index) {
    let image = this.film.get(index);
    if (!image) {
      image = new Image();
      image.onload = this.requestDraw;
      image.src = `/strip/${this.clip.id}/${index}?${this.clip.key}`;
      this.film.set(index, image);
    }
    return image.complete && image.naturalWidth ? image : null;
  }

  ruler(ctx, { width, height, scale, scroll }) {
    const step = TICKS.find((t) => t * scale >= LABEL_SPACE) || TICKS.at(-1);
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    ctx.font = `10.5px ${this.font}`;
    ctx.fillStyle = this.colors.dim;
    // The view starts before zero while the montage grows to the left.
    for (let i = Math.max(0, Math.floor(scroll / scale / step)); i * step * scale - scroll < width; i += 1) {
      const x = i * step * scale - scroll;
      ctx.globalAlpha = 1;
      ctx.fillText(format.duration(i * step, decimals), x + 5, 16);
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x, 6, 1, height - 6);
      for (let k = 1; k < 4; k += 1) ctx.fillRect(x + (k * step * scale) / 4, height - 5, 1, 5);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * `look` is { selected, hovered, faded, ghost, cut, off, style, name, gain, message, hiddenAt, edge }.
   * `cut` is for deleted content, `hiddenAt` marks edges that can give some back, `edge` is the one pointed at.
   * Like in editing software, a piece is a solid block of its track colour with a name strip.
   */
  piece(ctx, piece, view, look) {
    const { width, height: laneHeight, scale, scroll } = view;
    const x = piece.at * scale - scroll;
    const w = Math.max(2, lengthOf(piece) * scale);
    if (x > width || x + w < 0) return;

    const y = INSET;
    const h = laneHeight - INSET * 2;
    const left = Math.max(-RADIUS, x + 0.5);
    const right = Math.min(width + RADIUS, x + w - 0.5);
    const grey = look.off || piece.muted;
    const color = grey ? this.colors.off : this.colorOf(piece.lane);
    const { bg } = this.colors;
    const lit = look.selected || look.ghost;

    const box = new Path2D();
    box.roundRect(x + 0.5, y, Math.max(1, w - 1), h, Math.min(RADIUS, w / 2));

    ctx.save();
    if (look.cut) ctx.globalAlpha = look.cut;
    else ctx.globalAlpha = look.faded ? 0.25 : look.ghost ? 0.85 : 1;
    ctx.save();
    ctx.clip(box);
    ctx.fillStyle = mix(color, bg, lit ? 0.36 : 0.24);
    ctx.fillRect(left, y, right - left, h);

    const area = { x, y: y + STRIP, h: h - STRIP, left, right, scale };
    if (piece.lane === VIDEO) this.filmstrip(ctx, piece, area);
    else this.sound(ctx, piece, { ...area, color, off: grey }, look);

    ctx.fillStyle = mix(color, bg, lit ? 0.65 : 0.44);
    ctx.fillRect(left, y, right - left, STRIP);
    this.strip(ctx, piece, { y, left, right }, look.name);
    ctx.restore();

    ctx.lineWidth = look.selected ? 2 : 1;
    if (look.selected) ctx.strokeStyle = this.colors.text;
    else ctx.strokeStyle = look.hovered || look.cut ? color : bg;
    if (look.cut) ctx.setLineDash([4, 3]);
    ctx.stroke(box);
    ctx.setLineDash([]);

    const { hiddenAt } = look;
    if (hiddenAt && w > CORNER * 3) {
      ctx.fillStyle = this.colors.text;
      const bottom = y + h - 1;
      for (const side of hiddenAt) {
        const corner = side === 'start' ? x + 1 : x + w - 1;
        const inwards = side === 'start' ? CORNER : -CORNER;
        ctx.beginPath();
        ctx.moveTo(corner, bottom);
        ctx.lineTo(corner + inwards, bottom);
        ctx.lineTo(corner, bottom - CORNER);
        ctx.fill();
      }
    }
    if (look.edge) {
      ctx.fillStyle = this.colors.accent;
      ctx.fillRect(look.edge === 'start' ? x : x + w - 3, y, 3, h);
    }

    if ((look.selected || look.hovered) && w > EDGE * 3) {
      ctx.fillStyle = look.selected ? this.colors.text : color;
      for (const at of [x + 2, x + w - 5]) {
        ctx.beginPath();
        ctx.roundRect(at, y + h / 2 - 10, 3, 20, 1.5);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  filmstrip(ctx, piece, { x, y, h, left, right, scale }) {
    const { duration, filmFrames } = this.clip;
    for (let i = Math.max(0, Math.floor((left - x) / TILE)); x + i * TILE < right; i += 1) {
      const time = sourceAt(piece, piece.at + ((i + 0.5) * TILE) / scale);
      const index = Math.min(filmFrames - 1, Math.max(0, Math.floor((Math.min(piece.to, time) / duration) * filmFrames)));
      const image = this.frame(index);
      if (!image) continue;
      const fit = Math.max(TILE / image.naturalWidth, h / image.naturalHeight);
      const sw = TILE / fit;
      const sh = h / fit;
      ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x + i * TILE, y, TILE, h);
    }
  }

  sound(ctx, piece, area, look) {
    const track = this.tracks[piece.lane];
    if (!track) {
      ctx.fillStyle = this.colors.dim;
      ctx.font = `11px ${this.font}`;
      ctx.fillText(look.message, Math.max(4, area.left) + 8, area.y + area.h / 2 + 4);
      return;
    }
    const { color } = area;
    STYLES[look.style].paint(ctx, track, {
      ...area,
      ratio: window.devicePixelRatio || 1,
      color: piece.muted ? mix(color, this.colors.bg, 0.6) : mix(color, this.colors.text, 0.78),
      line: rgba(this.colors.bg, 0.55),
      from: piece.from,
      perPixel: piece.speed / area.scale,
      gain: look.gain * volumeOf(piece),
    });
  }

  /** Name, speed, volume and mute state, kept in view while scrolling through a long piece. */
  strip(ctx, piece, { y, left, right }, name) {
    let x = Math.max(0, left) + 8;
    ctx.font = `600 10.5px ${this.font}`;
    ctx.fillStyle = this.colors.text;
    if (piece.muted) {
      if (x + 14 > right) return;
      drawIcon(ctx, 'muted', x, y + 2, 12);
      x += 17;
    }
    const speed = Math.abs(piece.speed - 1) > 0.001 ? `×${Number(piece.speed.toFixed(2))}  ` : '';
    const volume = Math.abs(volumeOf(piece) - 1) > 0.001 ? `  ${t('piece.volumeShort', { n: Math.round(volumeOf(piece) * 100) })}` : '';
    let text = speed + name + volume + (piece.muted ? `, ${t('piece.mutedShort')}` : '');
    const room = right - x - 5;
    if (ctx.measureText(text).width > room) {
      while (text && ctx.measureText(`${text}…`).width > room) text = text.slice(0, -1);
      if (!text) return;
      text += '…';
    }
    ctx.fillText(text, x, y + 11.8);
  }

  /**
   * The handle of a cut on the picture, saying how much it can give back.
   * Returns where it was drawn, or null when there was no place left for it.
   */
  seam(ctx, seam, { width, height, scale, scroll }, { active, after }) {
    const { height: h, icon, padding, gap } = SEAM;
    ctx.font = `700 11px ${this.font}`;
    const text = format.seconds(seam.seconds);
    const arrows = (seam.start ? 1 : 0) + (seam.end ? 1 : 0);
    const w = padding * 2 + ctx.measureText(text).width + arrows * (icon + gap);
    const x = seam.at * scale - scroll;
    let left = x - w / 2;
    if (!seam.end) left = x + 3;
    else if (!seam.start) left = x - w - 3;
    if (left + w < 0 || left > width || left < after) return null;

    const top = STRIP + (height - STRIP - h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h / 2);
    ctx.fillStyle = active ? this.colors.accent : mix(this.colors.accent, this.colors.bg, 0.2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.colors.accent;
    ctx.stroke();

    ctx.fillStyle = active ? this.colors.bg : this.colors.accent;
    let at = left + padding;
    if (seam.start) {
      drawIcon(ctx, 'back', at, top + (h - icon) / 2, icon);
      at += icon + gap;
    }
    ctx.fillText(text, at, top + 15);
    if (seam.end) drawIcon(ctx, 'next', at + ctx.measureText(text).width + gap, top + (h - icon) / 2, icon);
    ctx.restore();
    return { seam, left, right: left + w, top, bottom: top + h };
  }

  range(ctx, [from, to], { height, scale, scroll }) {
    const x = from * scale - scroll;
    const w = (to - from) * scale;
    ctx.fillStyle = rgba(this.colors.accent, 0.22);
    ctx.fillRect(x, 0, w, height);
    ctx.fillStyle = this.colors.accent;
    ctx.fillRect(x, 0, 2, height);
    ctx.fillRect(x + w - 2, 0, 2, height);
  }

  /** Outside the zone, the lanes are dimmed. */
  zone(ctx, [from, to], { width, height, scale, scroll }) {
    const a = from * scale - scroll;
    const b = to * scale - scroll;
    ctx.fillStyle = rgba(this.colors.bg, 0.66);
    if (a > 0) ctx.fillRect(0, 0, a, height);
    if (b < width) ctx.fillRect(b, 0, width - b, height);
    ctx.fillStyle = rgba(this.colors.accent, 0.9);
    ctx.fillRect(a - 1, 0, 2, height);
    ctx.fillRect(b - 1, 0, 2, height);
  }

  /** The zone on the ruler: a band with a handle at each end. */
  zoneBand(ctx, [from, to], { height, scale, scroll }) {
    const a = from * scale - scroll;
    const b = to * scale - scroll;
    ctx.fillStyle = rgba(this.colors.accent, 0.2);
    ctx.fillRect(a, 0, b - a, height);
    ctx.fillStyle = this.colors.accent;
    ctx.fillRect(a, height - 5, b - a, 3);
    ctx.fillRect(a, 2, 4, height - 2);
    ctx.fillRect(b - 4, 2, 4, height - 2);
  }

  line(ctx, time, { height, scale, scroll }, color, size = 1) {
    ctx.fillStyle = color;
    ctx.fillRect(time * scale - scroll - size / 2, 0, size, height);
  }
}

export function visiblePieces(pieces, lane, { width, scale, scroll }) {
  const from = (scroll - 10) / scale;
  const to = (scroll + width + 10) / scale;
  return pieces.filter((piece) => piece.lane === lane && piece.at < to && endOf(piece) > from);
}
