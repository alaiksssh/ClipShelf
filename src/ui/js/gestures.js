// Pointer gestures on the timeline. A gesture only previews: nothing is committed before release,
// and Escape cancels it.
import * as P from '/shared/pieces.mjs';
import { zoneOf } from '/shared/edit.mjs';
import { planReveal, reveal } from '/shared/reveal.mjs';
import { setTransition, MIN_DURATION, MAX_DURATION } from '/shared/transitions.mjs';
import { clamp } from '/shared/geometry.mjs';
import * as format from './format.js';
import { t } from './i18n.js';

const DRAG_THRESHOLD = 4;
const SNAP = 8; // Pixels.
const PAN_ZONE = 24; // Pixels from the sides of the lanes.
const PAN_SPEED = [2, 0.2, 70]; // Pixels per step: slowest, gain per pixel past the side, fastest.

/** The nearest target within `tolerance`, or null. */
function nearest(value, targets, tolerance) {
  let best = null;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= tolerance && (best === null || distance < Math.abs(best - value))) best = target;
  }
  return best;
}

const edgesOf = (pieces) => pieces.flatMap((piece) => [piece.at, P.endOf(piece)]);

class Gesture {
  constructor(timeline, event) {
    this.timeline = timeline;
    this.editor = timeline.editor;
    this.startX = event.clientX;
    this.startTime = timeline.timeAt(event.clientX);
    this.moved = false;
  }

  move(event) {
    if (!this.moved && Math.abs(event.clientX - this.startX) < DRAG_THRESHOLD) return;
    this.moved = true;
    this.update(this.timeline.timeAt(event.clientX), event);
  }

  snap(time, targets) {
    if (!this.editor.magnet) return time;
    const hit = nearest(time, targets, SNAP / this.timeline.scale);
    this.timeline.guide = hit;
    return hit ?? time;
  }

  update() {}
  finish() {}
  cancel() {}
}

export class Scrub extends Gesture {
  constructor(timeline, event) {
    super(timeline, event);
    this.editor.player.pause();
    this.editor.player.seek(this.startTime);
  }

  update(time) {
    this.editor.player.seek(time);
  }
}

export class SelectRange extends Gesture {
  constructor(timeline, event, lane) {
    super(timeline, event);
    this.lane = lane;
    this.targets = [...edgesOf(this.editor.edit.pieces), this.editor.player.time];
    this.editor.select(null);
  }

  update(time) {
    const { editor } = this;
    const length = P.totalLength(editor.edit.pieces);
    const a = Math.min(length, this.startTime);
    const b = Math.min(length, Math.max(0, this.snap(time, this.targets)));
    editor.select(Math.abs(b - a) < P.MIN_LENGTH
      ? null
      : { type: 'range', lane: this.lane, range: [Math.min(a, b), Math.max(a, b)] });
  }

  finish() {
    const { editor } = this;
    if (!this.moved) {
      editor.player.seek(this.startTime);
      return;
    }
    // What is selected is also the zone that is played, exported and saved.
    if (editor.selection?.type === 'range') editor.change({ zone: editor.selection.range });
  }
}

/** Drags one end of the zone, on the ruler. */
export class ZoneEdge extends Gesture {
  constructor(timeline, event, edge) {
    super(timeline, event);
    this.edge = edge;
    this.zone = zoneOf(this.editor.edit);
    this.targets = [...edgesOf(this.editor.edit.pieces), this.editor.player.time];
  }

  update(time) {
    const { editor, zone } = this;
    const length = P.totalLength(editor.edit.pieces);
    const at = clamp(this.snap(time, this.targets), 0, length);
    const next = this.edge === 'start'
      ? [Math.min(at, zone[1] - P.MIN_LENGTH), zone[1]]
      : [zone[0], Math.max(at, zone[0] + P.MIN_LENGTH)];
    editor.edit = { ...editor.edit, zone: next };
    editor.player.seek(this.edge === 'start' ? next[0] : next[1]);
    this.timeline.draw();
    editor.toolbar.renderContext();
  }

  finish() {
    if (this.moved) this.editor.commit();
  }
}

export class Move extends Gesture {
  constructor(timeline, event, piece) {
    super(timeline, event);
    const { edit, selection } = this.editor;
    this.piece = piece;
    this.ids = new Set(selection.ids);
    this.base = edit.pieces;
    this.others = this.base.filter((p) => !this.ids.has(p.id));
    this.span = this.editor.commands.rippleSpan();

    if (this.span) {
      const [start, end] = this.span;
      // Parts can land at every cut of the picture outside of themselves.
      this.destinations = [...edgesOf(this.base.filter((p) => p.lane === P.VIDEO)), 0, P.totalLength(this.base)]
        .filter((time) => time < start - P.EPS || time > end + P.EPS);
      this.copy = P.copySpan(this.base, this.span);
    } else {
      this.targets = [0, this.editor.player.time, ...edgesOf(this.others)];
    }
  }

  update(time) {
    if (!this.moved) return;
    const shift = time - this.startTime;
    const { timeline, editor } = this;

    if (this.span) {
      const [start, end] = this.span;
      const inside = time >= start && time <= end;
      this.destination = inside || !this.destinations.length
        ? null
        : this.destinations.reduce((best, t) => (Math.abs(t - time) < Math.abs(best - time) ? t : best));
      timeline.ghost = {
        span: this.span,
        destination: this.destination,
        pieces: this.copy.map((p) => ({ ...p, at: p.at + Math.max(0, start + shift) })),
      };
      timeline.draw();
      return;
    }

    let snapped = shift;
    if (editor.magnet) {
      let best = null;
      for (const edge of edgesOf(this.base.filter((p) => this.ids.has(p.id)))) {
        const hit = nearest(edge + shift, this.targets, SNAP / timeline.scale);
        if (hit === null) continue;
        const distance = Math.abs(hit - edge - shift);
        if (!best || distance < best.distance) best = { hit, edge, distance };
      }
      timeline.guide = best?.hit ?? null;
      if (best) snapped = best.hit - best.edge;
    }
    editor.preview(P.moveFree(this.base, this.ids, snapped));
  }

  finish() {
    const { editor } = this;
    if (!this.moved) {
      editor.player.seek(this.startTime); // A plain click also places the playhead.
      return;
    }
    if (!this.span) {
      editor.commit();
      return;
    }
    if (this.destination === null || this.destination === undefined) return;
    const [start, end] = this.span;
    const { destination } = this;
    const landed = destination < start ? destination : destination - (end - start);
    editor.apply(P.rippleMove(this.base, this.span, destination));
    editor.player.seek(landed);
  }
}

/**
 * Drags an end of a transition: it gets longer or shorter. At a cut it stays centred on it, so both
 * ends move; at an edge, the end on the edge stays.
 */
export class TransitionLength extends Gesture {
  constructor(timeline, event, transition, edge) {
    super(timeline, event);
    this.transition = transition;
    this.edge = edge;
    this.base = this.editor.edit.pieces;
    const owner = this.base.find((piece) => piece.id === transition.owner.id);
    this.value = owner[transition.owner.side === 'in' ? 'transitionIn' : 'transitionOut'];
    this.editor.player.pause();
  }

  update(time, event) {
    const { transition } = this;
    let length;
    if (transition.left && transition.right) length = 2 * Math.abs(time - transition.cut);
    else length = Math.abs(time - transition.cut);
    length = clamp(length, MIN_DURATION, MAX_DURATION);
    this.length = length;
    this.editor.preview(setTransition(this.base, transition.lane, transition.cut, { ...this.value, duration: length }));
    this.timeline.showHint(event, format.seconds(length), t('transition.dragHint'));
  }

  finish() {
    if (this.moved) this.editor.commit();
  }
}

/**
 * Drags an edge: inwards it shortens, outwards it gives back what was cut.
 *
 * `grip` is { piece, edge }, or { seam } for the handle of a cut, whose side follows the direction.
 * The pulled edge stays under the pointer. When the montage has to grow to the left, the view moves
 * instead, and keeps moving while the pointer rests beyond the side of the lanes.
 */
export class Trim extends Gesture {
  constructor(timeline, event, grip) {
    super(timeline, event);
    const { editor } = this;
    this.grip = grip;
    this.alt = event.altKey;
    this.original = editor.edit;
    this.base = editor.edit.pieces;
    this.playhead = editor.player.time;
    this.scale = timeline.scale;
    this.startScroll = timeline.el.scrollLeft;
    const { piece, edge, seam } = grip;
    const at = seam ? seam.at : edge === 'start' ? piece.at : P.endOf(piece);
    const side = timeline.ruler.getBoundingClientRect().left + this.startScroll;
    // The pointer position at which the pulled edge reaches the side: past it, only the view moves.
    const grabbed = this.startX - (side + at * timeline.scale - this.startScroll);
    this.leftmost = Math.min(this.startX, side + grabbed);
    this.scrolled = 0; // By this gesture.
    this.pan = 0; // Room made on the left.
    this.state = null;
    editor.player.pause();
  }

  sideFor(delta) {
    const { piece, edge, seam } = this.grip;
    if (!seam) return { piece, edge };
    if (seam.start && (delta < 0 || !seam.end)) return { piece: seam.start, edge: 'start' };
    return { piece: seam.end, edge: 'end' };
  }

  update(time, event) {
    const delta = (Math.max(event.clientX, this.leftmost) - this.startX + this.scrolled - this.pan) / this.scale;
    const { piece, edge } = this.sideFor(delta);
    const outwards = edge === 'start' ? -delta : delta;
    const state = outwards >= 0 ? this.grow(piece, edge, outwards, event) : this.shrink(piece, edge, -outwards);
    this.state = { ...state, piece, edge };

    const { editor, timeline } = this;
    timeline.trimming = { lane: state.lane ?? piece.lane, edge, time: state.time };
    timeline.remaining = state.remaining || [];
    // Markers keep their place during the drag: they are drawn from the montage as it was.
    timeline.trim = { shift: state.shift * this.scale, pieces: state.pieces };
    editor.preview(state.pieces);
    // Read after the preview: a shorter montage can move the scroll position by itself.
    timeline.setOffset(timeline.el.scrollLeft - this.startScroll - this.scrolled + this.pan + state.shift * this.scale);
    // Show the frame being trimmed to.
    editor.player.seek(edge === 'start' ? state.time : Math.max(0, state.time - 0.02));
    timeline.showHint(event, ...state.hint);
  }

  grow(piece, edge, outwards, event) {
    const { editor } = this;
    const plan = planReveal(this.base, piece, edge, {
      clip: editor.clip,
      linked: editor.linked !== this.alt,
      beyond: event.shiftKey,
    });
    let amount = Math.min(outwards, plan.max);
    // The stop always holds: it is where the cut closes.
    if (amount > 0 && plan.max - outwards < SNAP / this.scale) amount = plan.max;
    this.timeline.guide = plan.max && amount === plan.max && !plan.picture
      ? plan.time + (edge === 'start' ? -amount : amount)
      : null;

    const { pieces, push, time } = reveal(this.base, plan, amount);
    const left = plan.max - amount;
    let hint;
    if (!plan.max) {
      if (plan.blocked) hint = [t('gesture.noRoom'), t('gesture.touching')];
      else if (edge === 'start' && piece.from < 0.05) hint = [t('gesture.videoStart')];
      else if (edge === 'end' && editor.clip.duration - piece.to < 0.05) hint = [t('gesture.videoEnd')];
      else hint = [t('gesture.nothingCut'), t('gesture.shift')];
    } else if (left < 0.01) {
      hint = [`+${format.seconds(plan.max)}`, t('gesture.allBack')];
    } else {
      hint = [`+${format.seconds(amount)}`, t('gesture.left', { length: format.seconds(left) })];
    }

    return {
      pieces,
      time,
      hint,
      lane: plan.anchor.lane,
      atLimit: left < 0.01,
      // What grows to the left pushes the rest, so the view moves back by as much.
      shift: edge === 'start' ? -push : 0,
      remaining: left < 0.05 ? [] : plan.members.map((member) => {
        const given = amount * member.speed;
        const total = plan.max * member.speed;
        return edge === 'start'
          ? { ...member, at: time - left, from: Math.max(0, member.from - total), to: member.from - given }
          : { ...member, at: time, from: member.to + given, to: member.to + total };
      }),
    };
  }

  shrink(piece, edge, inwards) {
    const { editor, base } = this;
    const isStart = edge === 'start';
    const at = isStart ? piece.at : P.endOf(piece);
    const linked = editor.linkedFor(piece, this.alt);
    const picture = piece.lane === P.VIDEO || (linked && base.some((p) => p.lane === P.VIDEO
      && p.group === piece.group && Math.abs((isStart ? p.at : P.endOf(p)) - at) < P.EPS));
    const ripple = editor.magnet && linked && picture;

    const follows = (p) => (linked ? p.group === piece.group : p.id === piece.id);
    const targets = [this.playhead, ...edgesOf(base.filter((p) => !follows(p)))];
    const wanted = this.snap(isStart ? at + inwards : at - inwards, targets);
    const amount = clamp(isStart ? wanted - at : at - wanted, 0, Math.max(0, P.lengthOf(piece) - P.MIN_LENGTH));
    const pieces = P.trim(base, piece.id, edge, isStart ? amount : -amount, {
      linked,
      ripple,
      duration: editor.clip.duration,
    });
    const done = pieces === base ? 0 : amount;
    if (ripple && isStart) this.timeline.guide = null; // What it snapped to has moved along.

    let time = isStart ? at + done : at - done;
    if (ripple && isStart) time = at;
    return {
      pieces,
      time,
      hint: [`−${format.seconds(done)}`, format.seconds(P.lengthOf(piece) - done)],
      shift: ripple && isStart ? done : 0,
    };
  }

  /** Called regularly while dragging. Returns whether something moved. */
  autoscroll({ clientX }, { left, right }) {
    const { timeline, state } = this;
    const speed = (past) => Math.min(PAN_SPEED[2], PAN_SPEED[0] + past * PAN_SPEED[1]);
    const before = timeline.el.scrollLeft;

    if (clientX < left + PAN_ZONE && clientX < this.startX - DRAG_THRESHOLD) {
      // From where it was grabbed when that is already beside the side: a small pull stays slow.
      const step = speed(Math.min(left + PAN_ZONE, this.startX) - clientX);
      if (state?.edge === 'start') {
        if (state.atLimit) return false;
        this.pan += step;
        return true;
      }
      timeline.el.scrollLeft = before - step;
    } else if (clientX > right - PAN_ZONE && clientX > this.startX + DRAG_THRESHOLD) {
      const step = speed(clientX - Math.max(right - PAN_ZONE, this.startX));
      if (this.pan) {
        this.pan = Math.max(0, this.pan - step);
        return true;
      }
      if (state?.atLimit && state.edge === 'end') return false;
      timeline.el.scrollLeft = before + step;
    } else {
      return false;
    }
    const moved = timeline.el.scrollLeft - before;
    this.scrolled += moved;
    return moved !== 0;
  }

  cancel() {
    if (this.moved) this.editor.player.seek(this.playhead);
  }

  finish() {
    if (!this.state) return;
    const { editor, timeline, state, base, original } = this;
    const { pieces, edge, time } = state;
    if (pieces === base) {
      editor.restore(original);
      timeline.settle();
      return;
    }
    editor.commit();
    const lane = state.lane ?? state.piece.lane;
    const kept = P.pieceAt(pieces, lane, edge === 'start' ? time + P.EPS : time - P.EPS);
    if (kept) editor.selectPiece(kept, { linked: editor.linkedFor(kept, this.alt) });
    timeline.settle();
  }
}
