import { h, icon, slider, setSlider } from './dom.js';
import { VIDEO, EPS, endOf, onLane, pieceAt, totalLength } from '/shared/pieces.mjs';
import { planReveal, reveal, seamsOf, soundHoles } from '/shared/reveal.mjs';
import * as format from './format.js';
import { MAX_VOLUME, audibleTracks, zoneOf } from '/shared/edit.mjs';
import { clamp } from '/shared/geometry.mjs';
import { volumeField } from './volumeField.js';
import { prepareTrack } from './waveforms.js';
import { Painter, TRACK_COLORS, EDGE, prepareCanvas, visiblePieces, transitionBox } from './painter.js';
import { Scrub, SelectRange, Move, Trim, ZoneEdge, TransitionLength } from './gestures.js';
import { transitionsOf } from '/shared/transitions.mjs';
import { MomentLane } from './momentLane.js';
import { t } from './i18n.js';

const HEAD = 236;
const RULER_HEIGHT = 26;
const VIDEO_HEIGHT = 62;
const TRACK_HEIGHT = 80;
const FIT_MARGIN = 12; // Pixels, to take the last edge from outside.
const MAX_SCALE = 600; // Pixels per second.
const AUTOSCROLL_ZONE = 24;
const SETTLE = 180; // Milliseconds.
const FIT_TIME = 220; // Milliseconds.

export class Timeline {
  constructor(editor) {
    this.editor = editor;
    this.scale = 0;
    this.width = 1;
    this.time = 0;
    this.fitted = true;
    this.hover = null;
    this.gesture = null;
    this.ghost = null;
    this.guide = null;
    this.offset = 0; // Pixels the view is moved by while an edge is being pulled.
    this.trimming = null;
    this.trim = null; // While an edge is dragged: { shift, pieces }.
    this.fitting = null;
    this.remaining = [];
    this.handles = [];
    this.pointed = null;
    this.message = t('timeline.analysing');
    this.painter = new Painter(editor.clip, () => this.draw());
    this.momentLane = new MomentLane(this);
    this.build();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.el);
  }

  build() {
    this.rulerCanvas = h('canvas');
    this.ruler = h('div', {
      class: 'lane',
      onPointerdown: (event) => {
        if (event.button !== 0) return;
        const edge = this.zoneEdgeAt(event.clientX);
        this.begin(event, edge ? new ZoneEdge(this, event, edge) : new Scrub(this, event));
      },
      onPointermove: (event) => {
        if (!this.gesture) this.ruler.style.cursor = this.zoneEdgeAt(event.clientX) ? 'ew-resize' : '';
      },
    }, this.rulerCanvas);

    this.lanes = [];
    this.heads = [];
    this.videoInfo = h('small');
    const video = this.createLane(VIDEO, VIDEO_HEIGHT);
    const tracks = this.editor.edit.tracks.map((_, i) => this.createTrack(i));

    this.playhead = h('div', { class: 'playhead' });
    this.inner = h('div', { class: 'timeline-inner' },
      h('div', { class: 'row ruler' }, h('div', { class: 'row-head caption' }, t('timeline.time')), this.ruler),
      this.momentLane.row,
      h('div', { class: 'row video' },
        h('div', { class: 'row-head' }, icon('film'), h('div', {}, h('b', {}, t('editor.video')), this.videoInfo)),
        video),
      tracks,
      !tracks.length && h('div', { class: 'row track' }, h('div', { class: 'row-head' }, t('timeline.noTracks'))),
      this.playhead);

    this.hint = h('div', { class: 'trim-hint', hidden: true });
    this.el = h('div', { class: 'timeline' }, this.inner, this.hint);
    this.el.addEventListener('scroll', () => {
      if (!this.gesture) this.hideHint();
      this.draw();
      this.placePlayhead();
    });
    this.el.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (this.gesture) return;
      this.zoom(event.deltaY < 0 ? 1.25 : 0.8, event.clientX);
    }, { passive: false });
  }

  createLane(lane, height) {
    const canvas = h('canvas');
    const el = h('div', {
      class: 'lane',
      'data-lane': String(lane),
      onPointerdown: (event) => this.press(event, lane),
      onPointermove: (event) => this.point(event, lane),
      onDblclick: (event) => this.pullAll(event, lane),
      onPointerleave: () => {
        if (this.gesture) return;
        this.pointed = null;
        this.hoveredTransition = null;
        this.hideHint();
        this.setHover(null);
        this.draw();
      },
      onContextmenu: (event) => {
        event.preventDefault();
        const time = this.timeAt(event.clientX);
        this.editor.timelineMenu(event, time, this.hit(lane, time)?.piece);
      },
    }, canvas);
    this.lanes.push({ lane, el, canvas, height });
    return el;
  }

  createTrack(index) {
    const { editor } = this;
    const change = (patch, options) => editor.changeTrack(index, patch, options);

    const name = h('input', {
      class: 'track-name',
      spellcheck: 'false',
      title: t('timeline.renameTrack'),
      placeholder: t('track.n', { n: index + 1 }),
      onChange: () => change({ name: name.value.trim().slice(0, 40) }),
      onKeydown: (event) => {
        if (event.key === 'Enter') name.blur();
      },
    });
    const note = h('span', { class: 'track-note' });
    const mute = h('button', {
      class: 'toggle mute',
      title: t('timeline.toggleTrack'),
      onClick: () => change({ on: !editor.edit.tracks[index].on }),
    });
    const solo = h('button', {
      class: 'toggle solo',
      title: t('timeline.solo'),
      onClick: () => change({ solo: !editor.edit.tracks[index].solo }),
    }, icon('solo'));
    const cut = h('button', {
      class: 'toggle cut',
      title: t('timeline.cutTrack'),
      'aria-label': t('timeline.cutTrack'),
      onClick: () => editor.commands.cutTrack(index),
    }, icon('scissors'));
    const volume = slider({
      min: 0, max: MAX_VOLUME, step: 0.01, value: 1,
      title: t('timeline.volume'),
      onInput: (value) => change({ volume: value }, { live: true }),
      onChange: () => editor.commit(),
      onDblclick: () => change({ volume: 1 }),
    });
    const amount = volumeField({
      // Back to the recorded value is not a change: it must not mark the clip as edited.
      onPreview: (value) => {
        if (editor.edit.tracks[index].volume !== value) editor.previewVolume(index, value);
      },
      onApply: (value) => change({ volume: value }),
    });

    const row = h('div', {
      class: 'row track',
      style: { '--tint': `var(--${TRACK_COLORS[index % TRACK_COLORS.length]})` },
    },
    h('div', { class: 'row-head' },
      h('div', { class: 'track-title' }, icon('wave'), name, note),
      h('div', { class: 'track-controls' }, mute, solo, cut, volume, amount.el)),
    this.createLane(index, TRACK_HEIGHT));

    this.heads[index] = { row, name, note, mute, solo, volume, amount, muted: null };
    return row;
  }

  setAnalysis(analysis) {
    const data = { ...analysis, duration: this.editor.clip.duration };
    analysis.tracks.forEach((info, i) => {
      if (!this.heads[i]) return;
      this.heads[i].name.placeholder = info.label || t('track.n', { n: i + 1 });
      // A note is a text of the dictionary: "Silent", "Same as track 2".
      const note = info.note ? t(info.note.key, info.note.params) : '';
      this.heads[i].note.textContent = note;
      this.heads[i].note.dataset.tip = note;
      this.painter.tracks[i] = prepareTrack(info, data, this.painter.colorOf(i));
    });
    this.draw();
  }

  fail(message) {
    this.message = message;
    this.draw();
  }

  // Geometry

  get length() {
    return Math.max(0.1, totalLength(this.editor.edit.pieces));
  }

  timeAt(clientX) {
    const left = this.ruler.getBoundingClientRect().left;
    return Math.max(0, (clientX - left - this.offset) / this.scale);
  }

  resize() {
    const width = Math.max(100, this.el.clientWidth - HEAD);
    if (width === this.width && this.scale) return;
    this.width = width;
    if (!this.scale || (this.fitted && this.gesture)) this.scale = this.fullScale;
    this.update();
  }

  layout() {
    const content = this.length * this.scale;
    // Some room after the end, to drop pieces there.
    const room = !this.fitted || content > this.width || this.gesture instanceof Move;
    const lane = room ? Math.max(this.width, content + this.width * 0.15) : this.width;
    this.inner.style.width = `${HEAD + lane}px`;
  }

  /** The scale at which the montage takes the whole width. */
  get fullScale() {
    return (this.width - FIT_MARGIN) / this.length;
  }

  fit() {
    this.fitted = true;
    this.update();
  }

  /**
   * The montage always takes the whole width, whatever was cut, unless it was zoomed further in.
   * The scale holds during a gesture, or the pointer would lose what it drags.
   */
  stretch() {
    if (this.gesture || this.fitting) return;
    const full = this.fullScale;
    if (this.scale <= full) this.fitted = true;
    if (!this.fitted) return;
    this.scale = full;
    this.el.scrollLeft = 0;
  }

  /** Scrolls to a time when it is out of the view. */
  reveal(time) {
    const x = time * this.scale;
    const { scrollLeft } = this.el;
    if (x < scrollLeft || x > scrollLeft + this.width) this.el.scrollLeft = Math.max(0, x - this.width * 0.3);
  }

  /** Zooms while keeping the time under `clientX`, or the playhead, in place. */
  zoom(factor, clientX) {
    const left = this.el.getBoundingClientRect().left + HEAD;
    const focus = clientX === undefined
      ? clamp(this.time * this.scale - this.el.scrollLeft, 0, this.width)
      : clamp(clientX - left, 0, this.width);
    const time = (this.el.scrollLeft + focus) / this.scale;
    const full = this.fullScale;
    const scale = clamp(this.scale * factor, full, Math.max(full, MAX_SCALE));
    if (scale <= full * 1.001) {
      this.fit();
      return;
    }
    this.scale = scale;
    this.fitted = false;
    this.layout();
    this.el.scrollLeft = time * this.scale - focus;
    this.update();
  }

  /** The end of the zone under the pointer, on the ruler. */
  zoneEdgeAt(clientX) {
    const zone = zoneOf(this.editor.edit);
    if (!zone) return null;
    const x = (time) => this.ruler.getBoundingClientRect().left + this.offset + time * this.scale;
    if (Math.abs(clientX - x(zone[0])) <= 7) return 'start';
    if (Math.abs(clientX - x(zone[1])) <= 7) return 'end';
    return null;
  }

  hit(lane, time) {
    let best = null;
    for (const piece of onLane(this.editor.edit.pieces, lane)) {
      const left = (time - piece.at) * this.scale;
      const right = (endOf(piece) - time) * this.scale;
      if (left < 0 || right < 0) continue;
      const grab = Math.min(EDGE, (left + right) / 4);
      const edge = left <= grab ? 'start' : right <= grab ? 'end' : null;
      best = { piece, edge };
    }
    return best;
  }

  /**
   * The transition under the pointer, with the side being grabbed when the pointer is on one of its
   * ends: { transition, edge }. Only the selection tool takes transitions.
   */
  transitionUnder(event, lane) {
    if (this.editor.tool !== 'select') return null;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left - this.offset;
    const y = event.clientY - box.top;
    const view = { height: box.height, scale: this.scale };
    for (const transition of transitionsOf(this.editor.edit.pieces, lane)) {
      const area = transitionBox(transition, view);
      if (y < area.top - 2 || y > area.bottom + 2 || x < area.left - 4 || x > area.right + 4) continue;
      let edge = null;
      if (area.right - area.left > 16) {
        if (Math.abs(x - area.left) <= 5) edge = 'start';
        else if (Math.abs(x - area.right) <= 5) edge = 'end';
      }
      return { transition, edge };
    }
    return null;
  }

  /**
   * What the selection tool takes here: the handle of a cut, an edge (also from just outside of it),
   * or deleted sound.
   */
  grip(event, lane) {
    if (this.editor.tool !== 'select') return null;
    const box = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - box.top;
    const x = event.clientX - box.left - this.offset;
    if (lane === VIDEO) {
      const handle = this.handles.find((a) => x >= a.left && x <= a.right && y >= a.top && y <= a.bottom);
      if (handle) return { seam: handle.seam };
    }

    const time = this.timeAt(event.clientX);
    const found = this.hit(lane, time);
    if (found) return found.edge ? found : null;

    let nearest = null;
    for (const piece of onLane(this.editor.edit.pieces, lane)) {
      for (const [edge, at] of [['start', piece.at], ['end', endOf(piece)]]) {
        const distance = Math.abs(at - time) * this.scale;
        if (distance <= EDGE && (!nearest || distance < nearest.distance)) nearest = { piece, edge, distance };
      }
    }
    if (nearest) return { piece: nearest.piece, edge: nearest.edge };
    if (lane === VIDEO) return null;

    const hole = soundHoles(this.editor.edit.pieces, this.editor.clip, lane)
      .find((h) => time >= h.at && time <= endOf(h));
    return hole ? { hole } : null;
  }

  // Pointer

  press(event, lane) {
    if (event.button !== 0) return;
    const { editor } = this;
    this.endSettle();
    const time = this.timeAt(event.clientX);
    const found = this.hit(lane, time);
    const grip = this.grip(event, lane);
    this.hideHint();

    const transition = this.transitionUnder(event, lane);
    if (transition) {
      const { owner } = transition.transition;
      editor.select({ type: 'transition', lane, id: owner.id, side: owner.side });
      if (transition.edge) this.begin(event, new TransitionLength(this, event, transition.transition, transition.edge));
      else editor.player.seek(transition.transition.cut);
    } else if (editor.tool === 'range') {
      this.begin(event, new SelectRange(this, event, lane));
    } else if (grip && !grip.hole && !event.ctrlKey) {
      const piece = grip.piece || grip.seam.start || grip.seam.end;
      editor.selectPiece(piece, { linked: editor.linkedFor(piece, event.altKey) });
      this.begin(event, new Trim(this, event, grip));
    } else if (!found) {
      editor.select(null);
      this.begin(event, new Scrub(this, event));
    } else if (editor.tool === 'razor' || editor.tool === 'razorTrack') {
      const snapped = editor.magnet && Math.abs(editor.player.time - time) * this.scale < EDGE
        ? editor.player.time
        : time;
      const linked = editor.tool === 'razor' && editor.linked !== event.altKey;
      editor.commands.cutPiece(found.piece, snapped, linked);
    } else if (event.ctrlKey) {
      editor.selectPiece(found.piece, { add: true });
    } else {
      const { selection } = editor;
      const keep = !event.altKey && editor.keepsSelection(found.piece);
      if (keep) editor.select({ ...selection, active: found.piece.id });
      else editor.selectPiece(found.piece, { linked: editor.linkedFor(found.piece, event.altKey) });
      this.begin(event, new Move(this, event, found.piece));
    }
  }

  begin(event, gesture) {
    this.cancel();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    this.gesture = gesture;
    this.layout();
    const before = this.editor.edit;
    let last = event;

    const move = (e) => {
      // The button was let go where no release reached the window (another window took the mouse):
      // the gesture ends there, or it would hold every shortcut until Escape.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        up();
        return;
      }
      last = e;
      gesture.move(e);
    };
    const scroller = setInterval(() => {
      if (!gesture.moved) return;
      const box = this.el.getBoundingClientRect();
      if (gesture.autoscroll) {
        const sides = { left: box.left + HEAD, right: box.left + this.el.clientWidth };
        if (gesture.autoscroll(last, sides)) gesture.move(last);
        return;
      }
      let step = 0;
      if (last.clientX > box.right - AUTOSCROLL_ZONE) step = 18;
      else if (last.clientX < box.left + HEAD && this.el.scrollLeft > 0) step = -18;
      if (!step) return;
      this.el.scrollLeft += step;
      gesture.move(last);
    }, 30);

    this.stop = (apply) => {
      this.stop = null;
      clearInterval(scroller);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      target.removeEventListener('lostpointercapture', up);
      this.gesture = null;
      this.ghost = null;
      this.guide = null;
      this.trimming = null;
      this.trim = null;
      this.remaining = [];
      this.pointed = null;
      this.hideHint();
      if (apply) {
        gesture.finish();
      } else {
        this.setOffset(0);
        this.editor.restore(before);
        gesture.cancel();
      }
      this.update();
    };
    const up = () => this.stop?.(true);
    const cancel = () => this.stop?.(false);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
    // Windows can take the capture away without a release, as when another window comes up.
    target.addEventListener('lostpointercapture', up);
  }

  /** Returns true when a gesture was cancelled. */
  cancel() {
    if (!this.stop) return false;
    this.stop(false);
    return true;
  }

  point(event, lane) {
    if (this.gesture) return;
    const over = this.transitionUnder(event, lane);
    const hovered = over && `${lane}|${over.transition.owner.id}|${over.transition.owner.side}`;
    if (hovered !== this.hoveredTransition) {
      this.hoveredTransition = hovered;
      this.draw();
    }
    if (over) {
      event.currentTarget.style.cursor = over.edge ? 'ew-resize' : 'pointer';
      const { kind, start, end } = over.transition;
      this.showHint(event, t(`transition.${kind}`), over.edge ? t('transition.dragHint') : format.seconds(end - start));
      this.setHover(null);
      return;
    }
    const found = this.hit(lane, this.timeAt(event.clientX));
    const grip = this.grip(event, lane);
    const { tool } = this.editor;
    let cursor = 'default';
    if (tool === 'range') cursor = 'text';
    else if (found && (tool === 'razor' || tool === 'razorTrack')) cursor = 'crosshair';
    else if (grip?.seam) cursor = 'ew-resize';
    else if (grip?.edge) cursor = `var(--cursor-${grip.edge})`;
    else if (grip?.hole) cursor = 'pointer';
    else if (found) cursor = 'grab';
    event.currentTarget.style.cursor = cursor;

    const key = grip && [lane, grip.edge, grip.piece?.id, grip.seam?.at, grip.hole?.at].join();
    if (key !== (this.pointed?.key ?? null)) {
      this.pointed = grip && { ...grip, key, hint: this.hintFor(grip) };
      this.draw();
    }
    if (this.pointed?.hint) this.showHint(event, ...this.pointed.hint);
    else this.hideHint();
    this.setHover(found?.piece.id ?? grip?.piece?.id ?? null);
  }

  hintFor({ piece, edge, seam, hole }) {
    const { editor } = this;
    if (hole) {
      return [t('timeline.soundRemoved', { length: format.seconds(hole.to - hole.from) }), t('timeline.holeHint')];
    }
    const all = t('timeline.dblRestore');
    if (seam) {
      let way = seam.start ? '←' : '→';
      if (seam.start && seam.end) way = t('timeline.either');
      return [t('timeline.drag', { way, length: format.seconds(seam.seconds) }), all];
    }
    const { max } = planReveal(editor.edit.pieces, piece, edge, { clip: editor.clip, linked: editor.linked });
    return max ? [t('timeline.drag', { way: edge === 'start' ? '←' : '→', length: format.seconds(max) }), all] : null;
  }

  /** A double click gives back everything an edge, a handle or a hole has. */
  pullAll(event, lane) {
    const grip = this.grip(event, lane);
    if (!grip) return;
    const { editor } = this;
    this.hideHint();
    if (grip.hole) {
      editor.commands.restore({ from: grip.hole.from, to: grip.hole.to, lanes: [lane] });
      return;
    }
    const { seam } = grip;
    const piece = seam ? seam.start || seam.end : grip.piece;
    const edge = seam ? (seam.start ? 'start' : 'end') : grip.edge;
    const before = editor.edit.pieces;
    const linked = editor.linked !== event.altKey;
    const plan = planReveal(before, piece, edge, { clip: editor.clip, linked, beyond: event.shiftKey });
    if (!plan.max) return;

    const { pieces, time } = reveal(before, plan, plan.max);
    editor.apply(pieces);
    const start = edge === 'start' ? time : time - plan.max;
    editor.player.seek(start);
    const kept = pieceAt(pieces, plan.anchor.lane, start + EPS);
    if (kept) editor.selectPiece(kept);
    this.pointed = null;
    this.settle();
  }

  showHint(event, title, detail) {
    const { hint } = this;
    if (hint.hidden || hint.dataset.text !== `${title}|${detail}`) {
      hint.dataset.text = `${title}|${detail}`;
      hint.replaceChildren(...[h('b', {}, title), detail && h('small', {}, detail)].filter(Boolean));
      hint.hidden = false;
    }
    const { offsetWidth, offsetHeight } = hint;
    // Below the pointer, so that it never covers the markers above the video.
    const below = event.clientY + 22;
    hint.style.left = `${clamp(event.clientX + 14, 8, innerWidth - offsetWidth - 8)}px`;
    hint.style.top = `${below + offsetHeight > innerHeight - 8 ? event.clientY - offsetHeight - 14 : below}px`;
  }

  hideHint() {
    this.hint.hidden = true;
  }

  setOffset(value) {
    this.offset = value;
    this.draw();
    this.placePlayhead();
  }

  endSettle() {
    cancelAnimationFrame(this.settling);
    this.settling = null;
    if (this.fitting) {
      this.fitting = null;
      this.offset = 0;
      this.update();
    }
    if (this.offset) this.setOffset(0);
  }

  /** After a pull: scroll so that nothing jumps, and slide whatever can't scroll. */
  settle() {
    cancelAnimationFrame(this.settling);
    // Was showing the whole montage: keep showing it, and get there smoothly so the eye follows.
    if (this.fitted) {
      const from = { scale: this.scale, offset: this.offset - this.el.scrollLeft };
      const to = this.fullScale;
      if (Math.abs(from.scale - to) < 1e-6 && Math.abs(from.offset) < 0.5) {
        this.setOffset(0);
        this.fit();
        return;
      }
      this.fitting = true;
      this.el.scrollLeft = 0;
      const started = performance.now();
      const step = (now) => {
        const progress = clamp((now - started) / FIT_TIME, 0, 1);
        const eased = 1 - (1 - progress) ** 3;
        this.scale = from.scale + (to - from.scale) * eased;
        this.offset = from.offset * (1 - eased);
        if (progress < 1) {
          this.layout();
          this.draw();
          this.placePlayhead();
          this.settling = requestAnimationFrame(step);
          return;
        }
        this.settling = null;
        this.fitting = null;
        this.offset = 0;
        this.fit();
      };
      step(started);
      return;
    }
    if (!this.offset) return;
    this.layout();
    const before = this.el.scrollLeft;
    this.el.scrollLeft = before - this.offset;
    const rest = this.offset + this.el.scrollLeft - before;
    const started = performance.now();
    const step = (now) => {
      const left = 1 - clamp((now - started) / SETTLE, 0, 1);
      this.setOffset(left ? rest * left ** 3 : 0);
      this.settling = left ? requestAnimationFrame(step) : null;
    };
    step(started);
  }

  setHover(id) {
    if (id === this.hover) return;
    this.hover = id;
    this.draw();
  }

  // Display

  update() {
    if (!this.scale) return;
    // What was under a still pointer may have moved: its hint comes back with the next move.
    if (!this.gesture) this.hideHint();
    this.stretch();
    this.momentLane.update();
    this.layout();
    this.updateHeads();
    this.draw();
    this.placePlayhead();
  }

  updateHeads() {
    const { pieces, tracks } = this.editor.edit;
    const count = onLane(pieces, VIDEO).length;
    this.videoInfo.textContent = t('timeline.pieces', { count });

    const audible = audibleTracks(tracks);
    tracks.forEach((state, i) => {
      const head = this.heads[i];
      head.row.classList.toggle('off', !audible[i]);
      head.mute.classList.toggle('on', !state.on);
      head.solo.replaceChildren(icon(state.solo ? 'soloOn' : 'solo'));
      if (head.muted !== !state.on) {
        head.muted = !state.on;
        head.mute.replaceChildren(icon(state.on ? 'volume' : 'muted'));
      }
      head.solo.classList.toggle('on', state.solo);
      if (document.activeElement !== head.name) head.name.value = state.name;
      setSlider(head.volume, state.volume);
      head.amount.set(state.volume);
    });
  }

  draw() {
    this.drawing ??= requestAnimationFrame(() => {
      this.drawing = null;
      this.paint();
    });
  }

  paint() {
    if (!this.scale || !this.el.isConnected) return;
    const { painter, width, scale, ghost, editor } = this;
    const { edit, selection } = editor;
    const scroll = this.el.scrollLeft - this.offset;
    const { accent } = painter.colors;
    const { clip } = editor;
    // While dragging, the handles would only get in the way.
    const pullable = editor.tool === 'select' && !this.gesture;
    this.momentLane.place(scale, this.offset - (this.trim?.shift || 0), this.trim?.pieces);

    const rulerContext = prepareCanvas(this.rulerCanvas, width, RULER_HEIGHT);
    const zone = zoneOf(edit);
    if (zone) painter.zoneBand(rulerContext, zone, { height: RULER_HEIGHT, scale, scroll });
    painter.ruler(rulerContext, { width, height: RULER_HEIGHT, scale, scroll });

    const audible = audibleTracks(edit.tracks);
    const selected = selection?.type === 'pieces' ? selection.ids : null;

    for (const { lane, canvas, height } of this.lanes) {
      const ctx = prepareCanvas(canvas, width, height);
      const view = { width, height, scale, scroll };
      const look = {
        style: editor.audioStyle,
        message: this.message,
        off: lane !== VIDEO && !audible[lane],
        name: lane === VIDEO ? t('editor.video') : editor.trackName(lane),
        gain: lane === VIDEO ? 1 : edit.tracks[lane].volume,
      };

      if (lane !== VIDEO) {
        for (const hole of soundHoles(edit.pieces, clip, lane)) {
          painter.piece(ctx, hole, view, { ...look, cut: 0.3, name: t('tool.removed') });
        }
      }
      for (const piece of visiblePieces(edit.pieces, lane, view)) {
        const middle = (piece.at + endOf(piece)) / 2;
        const hiddenAt = pullable && ['start', 'end'].filter((edge) =>
          planReveal(edit.pieces, piece, edge, { clip, linked: editor.linked }).max);
        let edge = this.pointed?.piece?.id === piece.id ? this.pointed.edge : null;
        const { trimming } = this;
        if (trimming) {
          const at = trimming.edge === 'start' ? piece.at : endOf(piece);
          edge = trimming.lane === lane && Math.abs(at - trimming.time) < EPS ? trimming.edge : null;
        }
        painter.piece(ctx, piece, view, {
          ...look,
          selected: selected?.has(piece.id),
          hovered: piece.id === this.hover,
          hiddenAt,
          edge,
          faded: ghost && middle >= ghost.span[0] && middle < ghost.span[1],
        });
      }
      for (const piece of visiblePieces(this.remaining, lane, view)) {
        painter.piece(ctx, piece, view, { ...look, cut: 0.5, name: t('timeline.cut') });
      }
      for (const transition of transitionsOf(edit.pieces, lane)) {
        const { owner } = transition;
        painter.transition(ctx, transition, view, {
          selected: selection?.type === 'transition' && selection.lane === lane && selection.id === owner.id && selection.side === owner.side,
          hovered: this.hoveredTransition === `${lane}|${owner.id}|${owner.side}`,
        });
      }
      if (lane === VIDEO) {
        this.handles = [];
        let after = -Infinity;
        for (const seam of pullable ? seamsOf(edit.pieces, clip, editor.linked) : []) {
          const active = this.pointed?.seam?.at === seam.at;
          const drawn = painter.seam(ctx, seam, view, { active, after });
          if (!drawn) continue;
          after = drawn.right + 4;
          // Kept in lane pixels, like the pointer.
          this.handles.push({ ...drawn, left: drawn.left + scroll, right: drawn.right + scroll });
        }
      }
      if (ghost) {
        for (const piece of visiblePieces(ghost.pieces, lane, view)) {
          painter.piece(ctx, piece, view, { ...look, ghost: true, selected: true });
        }
        if (ghost.destination !== null) painter.line(ctx, ghost.destination, view, accent, 4);
      }
      if (selection?.type === 'range' && (selection.lane === lane || selection.lane === VIDEO)) {
        painter.range(ctx, selection.range, view);
      }
      if (zone) painter.zone(ctx, zone, view);
      if (this.guide !== null) painter.line(ctx, this.guide, view, accent);
    }
  }

  placePlayhead() {
    const x = this.time * this.scale;
    this.playhead.style.transform = `translateX(${HEAD + x + this.offset}px)`;
    // Otherwise it would show over the track headers.
    this.playhead.style.visibility = x + this.offset < this.el.scrollLeft - 1 ? 'hidden' : '';
  }

  setTime(time, follow = false) {
    this.time = time;
    if (follow && !this.gesture) {
      const x = time * this.scale;
      const { scrollLeft } = this.el;
      if (x < scrollLeft || x > scrollLeft + this.width - 10) this.el.scrollLeft = Math.max(0, x - this.width * 0.1);
    }
    this.placePlayhead();
  }

  dispose() {
    this.cancel();
    this.observer.disconnect();
    cancelAnimationFrame(this.drawing);
    cancelAnimationFrame(this.settling);
  }
}
