// A montage is a flat list of pieces placed on the output timeline:
//   { id, group, lane, at, from, to, speed, muted, volume }
// `at` is the position in the montage, `from`/`to` the part of the source it plays.
// Lane -1 is the picture, lanes 0..n are the audio tracks. Pieces of a lane never overlap.
// Pieces sharing a `group` are linked: they are selected, moved and trimmed together.
// `volume` is the gain of one piece of sound, on top of the volume of its track (1 leaves it as is).
// A piece saved before it existed has none, which means 1.
//
// Every operation is pure and returns a new list, or the same one when nothing can change.
import { clamp } from './geometry.mjs';

export const VIDEO = -1;
export const EPS = 0.001;
export const MIN_LENGTH = 0.05;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];
export const MAX_PIECE_VOLUME = 2;

export const lengthOf = (piece) => (piece.to - piece.from) / piece.speed;
export const endOf = (piece) => piece.at + lengthOf(piece);
export const sourceAt = (piece, time) => piece.from + (time - piece.at) * piece.speed;
export const volumeOf = (piece) => piece.volume ?? 1;

/**
 * Whether the cut between two pieces of a lane can close: they play alike, and no transition is
 * placed there.
 */
export const soundsAlike = (a, b) => a.speed === b.speed && a.muted === b.muted
  && Math.abs(volumeOf(a) - volumeOf(b)) < EPS && !a.transitionOut && !b.transitionIn;

/** The two halves of a cut piece: the transition at its start stays left, the one at its end goes right. */
function halves(piece) {
  const { transitionIn, transitionOut, ...rest } = piece;
  return [
    transitionIn ? { ...rest, transitionIn } : rest,
    transitionOut ? { ...rest, transitionOut } : rest,
  ];
}

export function totalLength(pieces) {
  return pieces.reduce((max, piece) => Math.max(max, endOf(piece)), 0);
}

export function onLane(pieces, lane) {
  return pieces.filter((piece) => piece.lane === lane).sort((a, b) => a.at - b.at);
}

export function pieceAt(pieces, lane, time) {
  return pieces.find((piece) => piece.lane === lane && time >= piece.at - 1e-6 && time < endOf(piece) - 1e-6);
}

export function spanOf(pieces) {
  return [Math.min(...pieces.map((piece) => piece.at)), Math.max(...pieces.map(endOf))];
}

/** The ids of every piece linked to the given ones. */
export function withLinked(pieces, ids) {
  const groups = new Set(pieces.filter((piece) => ids.has(piece.id)).map((piece) => piece.group));
  return new Set(pieces.filter((piece) => groups.has(piece.group)).map((piece) => piece.id));
}

/**
 * Whether a sound piece is picked without its linked pieces. This is the case once its track was cut
 * on its own. The picture still carries all of them.
 */
export function standsAlone(pieces, piece) {
  if (piece.lane === VIDEO) return false;
  const others = pieces.filter((p) => p.group === piece.group && p !== piece);
  const sameSpan = (p) => Math.abs(p.at - piece.at) < EPS && Math.abs(endOf(p) - endOf(piece)) < EPS;
  if (others.some((p) => p.lane === VIDEO && sameSpan(p))) return false;
  return others.some((p) => p.lane === VIDEO || p.lane === piece.lane);
}

/** Hands out ids and groups that the list doesn't use yet. */
export function counters(pieces) {
  let id = pieces.reduce((max, piece) => Math.max(max, piece.id), 0);
  let group = pieces.reduce((max, piece) => Math.max(max, piece.group), 0);
  return { id: () => (id += 1), group: () => (group += 1) };
}

/**
 * Cuts the pieces crossing `time`. The right halves stay linked to each other, as a new group.
 * With `keepGroup`, they stay linked to their left half too.
 */
export function split(pieces, time, { only = () => true, keepGroup = false } = {}) {
  const crosses = (piece) => piece.at < time - EPS && endOf(piece) > time + EPS && only(piece);
  if (!pieces.some(crosses)) return pieces;
  const next = counters(pieces);
  const groups = new Map();
  // When a picture is cut, linked sound that was already cut further right goes with its right half.
  if (!keepGroup) {
    for (const piece of pieces) {
      if (piece.lane === VIDEO && crosses(piece) && !groups.has(piece.group)) groups.set(piece.group, next.group());
    }
  }
  const pictures = new Set(groups.keys());
  return pieces.flatMap((piece) => {
    if (!crosses(piece)) {
      const follows = pictures.has(piece.group) && piece.at >= time - EPS && only(piece);
      return [follows ? { ...piece, group: groups.get(piece.group) } : piece];
    }
    const middle = sourceAt(piece, time);
    if (!groups.has(piece.group)) groups.set(piece.group, keepGroup ? piece.group : next.group());
    const [left, right] = halves(piece);
    return [
      { ...left, to: middle },
      { ...right, id: next.id(), group: groups.get(piece.group), at: time, from: middle },
    ];
  });
}

function cutOut(pieces, [start, end]) {
  return split(split(pieces, start), end);
}

const inside = (piece, [start, end]) => {
  const middle = piece.at + lengthOf(piece) / 2;
  return middle >= start && middle < end;
};

/** Removes a span from every lane and closes the hole. */
export function rippleDelete(pieces, span) {
  const [start, end] = span;
  if (end - start < EPS) return pieces;
  return cutOut(pieces, span)
    .filter((piece) => !inside(piece, span))
    .map((piece) => (piece.at >= end - EPS ? { ...piece, at: Math.max(0, piece.at - (end - start)) } : piece));
}

/** Pushes everything from `time` later by `length`. */
export function insertSpace(pieces, time, length) {
  return split(pieces, time).map((piece) =>
    (piece.at >= time - EPS ? { ...piece, at: piece.at + length } : piece));
}

/**
 * Takes a span out of every lane and puts it back at `destination`, shifting what is between.
 * It is a permutation of time, so lanes stay in sync and can never overlap.
 */
export function rippleMove(pieces, span, destination) {
  const [start, end] = span;
  if (destination >= start - EPS && destination <= end + EPS) return pieces;
  const length = end - start;
  const before = destination < start;
  const between = before ? [destination, start] : [end, destination];
  const shift = before ? destination - start : destination - end;

  return split(cutOut(pieces, span), destination).map((piece) => {
    if (inside(piece, span)) return { ...piece, at: piece.at + shift };
    if (inside(piece, between)) return { ...piece, at: piece.at + (before ? length : -length) };
    return piece;
  });
}

/** What a span contains, on every lane, relative to its start. */
export function copySpan(pieces, span) {
  return cutOut(pieces, span)
    .filter((piece) => inside(piece, span))
    .map((piece) => ({ ...piece, at: piece.at - span[0] }));
}

function renumber(pieces, items) {
  const next = counters([...pieces, ...items]);
  const groups = new Map();
  return items.map((item) => {
    if (!groups.has(item.group)) groups.set(item.group, next.group());
    return { ...item, id: next.id(), group: groups.get(item.group) };
  });
}

/** Inserts copied pieces at `time`, pushing the rest. Returns the list and the new ids. */
export function insert(pieces, items, time, length) {
  const base = insertSpace(pieces, time, length);
  const added = renumber(base, items).map((item) => ({ ...item, at: item.at + time }));
  return { pieces: [...base, ...added], ids: added.map((item) => item.id) };
}

/** The shift closest to `wanted` at which `moving` overlaps nothing in `others`. */
export function freeShift(others, moving, wanted) {
  const blocked = [];
  for (const piece of moving) {
    for (const other of others) {
      if (other.lane === piece.lane) blocked.push([other.at - endOf(piece), endOf(other) - piece.at]);
    }
  }
  const lowest = -Math.min(...moving.map((piece) => piece.at));
  const allowed = (shift) => shift >= lowest - 1e-9
    && blocked.every(([a, b]) => shift <= a + 1e-6 || shift >= b - 1e-6);
  return [Math.max(lowest, wanted), lowest, ...blocked.flat()]
    .filter(allowed)
    .reduce((best, shift) => (Math.abs(shift - wanted) < Math.abs(best - wanted) ? shift : best), Infinity);
}

/** Moves pieces without pushing anything, to the closest free place. */
export function moveFree(pieces, ids, wanted) {
  const moving = pieces.filter((piece) => ids.has(piece.id));
  if (!moving.length) return pieces;
  const shift = freeShift(pieces.filter((piece) => !ids.has(piece.id)), moving, wanted);
  if (!Number.isFinite(shift) || Math.abs(shift) < EPS) return pieces;
  return pieces.map((piece) => (ids.has(piece.id) ? { ...piece, at: Math.max(0, piece.at + shift) } : piece));
}

/** Pastes pieces at the closest free place, without pushing anything. */
export function place(pieces, items, time) {
  const added = renumber(pieces, items).map((item) => ({ ...item, at: item.at + time }));
  const shift = freeShift(pieces, added, 0);
  if (!Number.isFinite(shift)) return { pieces, ids: [] };
  return {
    pieces: [...pieces, ...added.map((item) => ({ ...item, at: item.at + shift }))],
    ids: added.map((item) => item.id),
  };
}

/**
 * Drags the 'start' or 'end' edge of a piece by `delta` seconds of montage.
 * With `linked`, pieces of the group sharing this edge follow.
 * With `ripple`, the rest of the montage follows too, so no hole appears.
 */
export function trim(pieces, id, edge, delta, { linked, ripple, duration }) {
  const piece = pieces.find((p) => p.id === id);
  if (!piece) return pieces;
  const isStart = edge === 'start';
  const edgeOf = isStart ? (p) => p.at : endOf;
  const edgeTime = edgeOf(piece);
  const members = linked
    ? pieces.filter((p) => p.group === piece.group && Math.abs(edgeOf(p) - edgeTime) < EPS)
    : [piece];

  let low = -Infinity;
  let high = Infinity;
  // Only the dragged piece limits shrinking: shorter linked parts of a cut track are removed.
  const shrink = Math.max(0, lengthOf(piece) - MIN_LENGTH);
  for (const member of members) {
    let grow = Math.max(0, (isStart ? member.from : duration - member.to) / member.speed);
    if (!ripple) {
      const others = pieces.filter((p) => p.lane === member.lane && p !== member);
      const room = isStart
        ? member.at - Math.max(0, ...others.filter((p) => p.at < member.at).map(endOf))
        : Math.min(Infinity, ...others.filter((p) => p.at > member.at).map((p) => p.at)) - endOf(member);
      grow = Math.min(grow, Math.max(0, room));
    }
    low = Math.max(low, isStart ? -grow : -shrink);
    high = Math.min(high, isStart ? shrink : grow);
  }
  const amount = clamp(delta, low, high);
  if (Math.abs(amount) < EPS) return pieces;

  let result = pieces;
  let change;
  if (!ripple && linked && (isStart ? amount > 0 : amount < 0)) {
    // Every linked part within the removed span, not only those touching the edge.
    const cut = edgeTime + amount;
    const lanes = new Set(members.map((member) => member.lane));
    return pieces.flatMap((p) => {
      if (p.group !== piece.group || !lanes.has(p.lane)) return [p];
      if (isStart) {
        if (p.at < edgeTime - EPS || p.at >= cut - EPS) return [p];
        return endOf(p) <= cut + EPS ? [] : [{ ...p, at: cut, from: sourceAt(p, cut) }];
      }
      if (endOf(p) > edgeTime + EPS || endOf(p) <= cut + EPS) return [p];
      return p.at >= cut - EPS ? [] : [{ ...p, to: sourceAt(p, cut) }];
    });
  }
  if (!ripple) {
    change = (p) => (isStart
      ? { ...p, at: p.at + amount, from: p.from + amount * p.speed }
      : { ...p, to: p.to + amount * p.speed });
  } else if (isStart && amount > 0) {
    return rippleDelete(pieces, [edgeTime, edgeTime + amount]);
  } else if (!isStart && amount < 0) {
    return rippleDelete(pieces, [edgeTime + amount, edgeTime]);
  } else if (isStart) {
    result = insertSpace(pieces, edgeTime, -amount);
    change = (p) => ({ ...p, at: p.at + amount, from: p.from + amount * p.speed });
  } else {
    result = insertSpace(pieces, edgeTime, amount);
    change = (p) => ({ ...p, to: p.to + amount * p.speed });
  }
  const ids = new Set(members.map((member) => member.id));
  return result.map((p) => (ids.has(p.id) ? change(p) : p));
}

/** Changes the speed of a piece. With `ripple`, its whole span scales and the rest follows. */
export function setSpeed(pieces, id, speed, { linked, ripple }) {
  const piece = pieces.find((p) => p.id === id);
  if (!piece) return pieces;
  const factor = speed / piece.speed;
  const scaled = (p) => ({ ...p, speed: clamp(p.speed * factor, MIN_SPEED, MAX_SPEED) });

  if (ripple) {
    const span = spanOf([piece]);
    const [start, end] = span;
    const parts = cutOut(pieces, span);
    // All lanes must scale by the same factor, or they would drift apart.
    const possible = parts.every((p) => !inside(p, span)
      || (p.speed * factor >= MIN_SPEED - EPS && p.speed * factor <= MAX_SPEED + EPS));
    if (!possible) return pieces;
    const shift = (end - start) / factor - (end - start);
    return parts.map((p) => {
      if (inside(p, span)) return { ...scaled(p), at: start + (p.at - start) / factor };
      return p.at >= end - EPS ? { ...p, at: p.at + shift } : p;
    });
  }

  const ids = linked ? withLinked(pieces, new Set([id])) : new Set([id]);
  // Linked parts keep their place relative to the piece, or a cut track would drift.
  const result = pieces.map((p) => (ids.has(p.id)
    ? { ...scaled(p), at: Math.max(0, piece.at + (p.at - piece.at) / factor) }
    : p));
  return hasOverlap(result) ? pieces : result;
}

/** Changes part of some tracks, cut out first. The parts stay linked to the picture. */
function patchRange(pieces, lanes, [start, end], patch) {
  const options = { only: (piece) => lanes.includes(piece.lane), keepGroup: true };
  return split(split(pieces, start, options), end, options).map((piece) =>
    (lanes.includes(piece.lane) && inside(piece, [start, end]) ? { ...piece, ...patch } : piece));
}

/** Silences part of a track. The parts stay linked to the picture. */
export function muteRange(pieces, lanes, range, muted = true) {
  return patchRange(pieces, lanes, range, { muted });
}

/** Sets the volume of part of some tracks, whatever each piece had there. */
export function volumeRange(pieces, lanes, range, volume) {
  return patchRange(pieces, lanes, range, { volume: clamp(volume, 0, MAX_PIECE_VOLUME) });
}

/** Sets the volume of the given pieces of sound. The picture has none. */
export function setVolume(pieces, ids, volume) {
  const value = clamp(volume, 0, MAX_PIECE_VOLUME);
  const changes = (piece) => ids.has(piece.id) && piece.lane !== VIDEO && Math.abs(volumeOf(piece) - value) >= EPS;
  if (!pieces.some(changes)) return pieces;
  return pieces.map((piece) => (changes(piece) ? { ...piece, volume: value } : piece));
}

/** Removes part of one lane and leaves a hole, so that nothing goes out of sync. */
export function clearRange(pieces, lane, range) {
  const options = { only: (piece) => piece.lane === lane, keepGroup: lane !== VIDEO };
  const cut = split(split(pieces, range[0], options), range[1], options);
  const result = cut.filter((piece) => piece.lane !== lane || !inside(piece, range));
  return result.length === cut.length ? pieces : result;
}

export function hasOverlap(pieces) {
  for (const lane of new Set(pieces.map((piece) => piece.lane))) {
    const row = onLane(pieces, lane);
    for (let i = 1; i < row.length; i += 1) if (row[i].at < endOf(row[i - 1]) - 0.01) return true;
  }
  return false;
}
