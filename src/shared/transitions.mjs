// Transitions, as in editing software. A piece may hold `transitionIn` (at its start) and
// `transitionOut` (at its end), each { kind, duration }.
//
// Between two pieces that touch on a lane, the transition is centred on the cut and blends the end of
// the first with the start of the second, using the frames of the file on either side of the cut
// ("handles"): the montage keeps its length and every lane stays in sync. The transition of such a cut
// is the `transitionIn` of the second piece, or else the `transitionOut` of the first.
// At an edge with nothing next to it (the start, the end, a gap, a muted piece), it is a fade from or
// to black (white for 'white'), or from or to silence on a track. It then starts or ends at the edge.
// A transition never takes more than half of a piece, so that two of them never overlap.
import { VIDEO, EPS, endOf, lengthOf, onLane } from './pieces.mjs';
import { clamp } from './geometry.mjs';

/** Kinds of the picture, with the name of the ffmpeg xfade transition that renders each one. */
export const VIDEO_KINDS = {
  dissolve: 'fade',
  black: 'fadeblack',
  white: 'fadewhite',
  wipe: 'wipeleft',
  slide: 'slideleft',
  iris: 'circleopen',
  zoom: 'zoomin',
};
/** Sound has one kind: a crossfade at constant power, or a fade at an edge. */
export const SOUND_KIND = 'crossfade';
export const DURATIONS = [0.25, 0.5, 1, 1.5, 2];
export const DEFAULT_DURATION = 0.5;
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 3;

const kindsOf = (lane) => (lane === VIDEO ? Object.keys(VIDEO_KINDS) : [SOUND_KIND]);

/** A valid transition for a lane, or undefined. */
export function cleanTransition(value, lane) {
  if (!value || typeof value !== 'object') return undefined;
  const kinds = kindsOf(lane);
  const kind = kinds.includes(value.kind) ? value.kind : kinds[0];
  const duration = Number(value.duration);
  if (!Number.isFinite(duration)) return undefined;
  return { kind, duration: clamp(duration, MIN_DURATION, MAX_DURATION) };
}

const touches = (a, b) => Boolean(a && b) && Math.abs(endOf(a) - b.at) < EPS;

/**
 * Every transition of a lane as it plays: { lane, kind, start, end, cut, left, right, owner }.
 * `left` and `right` are the pieces on either side (null at an edge), `owner` the piece and side that
 * hold it: { id, side: 'in' | 'out' }.
 */
export function transitionsOf(pieces, lane) {
  const row = onLane(pieces, lane).filter((piece) => !piece.muted);
  const list = [];
  row.forEach((piece, i) => {
    const before = touches(row[i - 1], piece) ? row[i - 1] : null;
    const after = touches(piece, row[i + 1]) ? row[i + 1] : null;
    if (before) {
      const own = piece.transitionIn || before.transitionOut;
      if (own) {
        const half = Math.min(own.duration / 2, lengthOf(before) / 2, lengthOf(piece) / 2);
        list.push({
          lane,
          kind: own.kind,
          start: piece.at - half,
          end: piece.at + half,
          cut: piece.at,
          left: before,
          right: piece,
          owner: piece.transitionIn ? { id: piece.id, side: 'in' } : { id: before.id, side: 'out' },
        });
      }
    } else if (piece.transitionIn) {
      const length = Math.min(piece.transitionIn.duration, lengthOf(piece) / 2);
      list.push({
        lane, kind: piece.transitionIn.kind, start: piece.at, end: piece.at + length, cut: piece.at,
        left: null, right: piece, owner: { id: piece.id, side: 'in' },
      });
    }
    if (!after && piece.transitionOut) {
      const length = Math.min(piece.transitionOut.duration, lengthOf(piece) / 2);
      list.push({
        lane, kind: piece.transitionOut.kind, start: endOf(piece) - length, end: endOf(piece), cut: endOf(piece),
        left: piece, right: null, owner: { id: piece.id, side: 'out' },
      });
    }
  });
  return list.filter((transition) => transition.end - transition.start > EPS);
}

/** The transition playing at `time`, if any. */
export function transitionAt(list, time) {
  return list.find((transition) => time >= transition.start - 1e-6 && time < transition.end - 1e-6);
}

/** How far a transition is at `time`, from 0 to 1. */
export function progressOf(transition, time) {
  return clamp((time - transition.start) / (transition.end - transition.start), 0, 1);
}

/** Gains of the outgoing and incoming sound at `progress`, at constant power. */
export function crossfadeGains(progress) {
  return [Math.cos((progress * Math.PI) / 2), Math.sin((progress * Math.PI) / 2)];
}

/**
 * The cut or the edge of a lane at `time`: where a transition can go. With both pieces, it is a cut.
 * Returns { lane, time, left, right } or null.
 */
export function edgeAt(pieces, lane, time, tolerance = EPS) {
  const row = onLane(pieces, lane);
  const right = row.find((piece) => Math.abs(piece.at - time) <= tolerance);
  const left = row.find((piece) => Math.abs(endOf(piece) - time) <= tolerance);
  if (!right && !left) return null;
  const cut = right ? right.at : endOf(left);
  return { lane, time: cut, left: left && (!right || touches(left, right)) ? left : null, right: right || null };
}

/** The edges of a lane, as times, for finding the one nearest to a place. */
export function edgesOf(pieces, lane) {
  return [...new Set(onLane(pieces, lane).flatMap((piece) => [piece.at, endOf(piece)]))].sort((a, b) => a - b);
}

/**
 * Puts a transition (or none, with `value` null) at the cut or edge of `lane` at `time`. At a cut it
 * goes on the piece after it, and the piece before lets go of its own.
 */
export function setTransition(pieces, lane, time, value) {
  const edge = edgeAt(pieces, lane, time);
  if (!edge) return pieces;
  const clean = value ? cleanTransition(value, lane) : undefined;
  const changes = new Map();
  if (edge.right) {
    changes.set(edge.right.id, { transitionIn: clean });
    if (edge.left) changes.set(edge.left.id, { transitionOut: undefined });
  } else {
    changes.set(edge.left.id, { transitionOut: clean });
  }
  let changed = false;
  const result = pieces.map((piece) => {
    const patch = changes.get(piece.id);
    if (!patch) return piece;
    const next = { ...piece, ...patch };
    for (const key of ['transitionIn', 'transitionOut']) if (next[key] === undefined) delete next[key];
    if (JSON.stringify(next) !== JSON.stringify(piece)) changed = true;
    return next;
  });
  return changed ? result : pieces;
}

/** Whether a piece of the picture needs its pixels redrawn: then it cannot be copied as recorded. */
export function blendsPicture(pieces) {
  return transitionsOf(pieces, VIDEO).length > 0;
}
