// What a montage no longer plays from its clip, and how to put it back.
//
// Nothing is recorded when something is deleted: the removed parts are whatever piece of the source
// no lane plays any more. So they can be found again after a restart, and in any saved montage.
import { VIDEO, EPS, counters, endOf, insertSpace, onLane, soundsAlike } from './pieces.mjs';

export const SHORTEST = 0.05; // Shorter than this is a rounding leftover.

/** The parts of the ranges that none of `holes` covers. */
export function subtract(ranges, holes) {
  let left = ranges;
  for (const [a, b] of holes) {
    left = left.flatMap(([from, to]) => {
      if (b <= from || a >= to) return [[from, to]];
      return [[from, a], [b, to]].filter(([x, y]) => y - x > EPS);
    });
  }
  return left;
}

export const played = (pieces, lane) => onLane(pieces, lane).map((piece) => [piece.from, piece.to]);
export const longEnough = ([from, to]) => to - from >= SHORTEST;

/** Returns [{ from, to, lanes }] in source time, by position in the clip. */
export function removedParts(pieces, { duration, audio }) {
  const all = [[0, duration]];
  const picture = subtract(all, played(pieces, VIDEO)).filter(longEnough);
  const parts = picture.map(([from, to]) => ({ from, to, lanes: [VIDEO] }));
  const soundOnly = [];

  for (let lane = 0; lane < audio.length; lane += 1) {
    const missing = subtract(all, played(pieces, lane)).filter(longEnough);
    for (const part of parts) {
      if (missing.some(([a, b]) => a < part.to - EPS && b > part.from + EPS)) part.lanes.push(lane);
    }
    for (const [from, to] of subtract(missing, picture).filter(longEnough)) {
      const same = soundOnly.find((part) => Math.abs(part.from - from) < EPS && Math.abs(part.to - to) < EPS);
      if (same) same.lanes.push(lane);
      else soundOnly.push({ from, to, lanes: [lane] });
    }
  }
  return [...parts, ...soundOnly].sort((a, b) => a.from - b.from);
}

/** Where a picture part goes: next to what surrounds it in the clip, with the room there is. */
function placeOf(pieces, { from, to }) {
  const video = onLane(pieces, VIDEO);
  const close = (a, b) => Math.abs(a - b) < SHORTEST;
  const closest = (list, value) => list.reduce((best, p) => (!best || value(p) < value(best) ? p : best), null);

  let previous = video.find((p) => close(p.to, from));
  let next = previous ? null : video.find((p) => close(p.from, to));
  if (!previous && !next) {
    previous = closest(video.filter((p) => p.to <= from + SHORTEST), (p) => from - p.to);
    if (!previous) next = closest(video.filter((p) => p.from >= to - SHORTEST), (p) => p.from - to);
  }
  if (next) {
    const before = video.indexOf(next) - 1;
    const free = before < 0 ? 0 : endOf(video[before]);
    return { time: Math.max(free, next.at - (to - from)), room: next.at - free };
  }
  const at = previous ?? video.at(-1);
  if (!at) return { time: 0, room: Infinity };
  const after = video[video.indexOf(at) + 1];
  return { time: endOf(at), room: after ? after.at - endOf(at) : Infinity };
}

/**
 * Removes the cuts at `time` when every lane plays straight on through them,
 * so that restoring gives back the montage from before the deletion.
 */
export function join(pieces, time, lanes) {
  const concerned = (piece) => !lanes || lanes.includes(piece.lane);
  const lefts = pieces.filter((piece) => concerned(piece) && Math.abs(endOf(piece) - time) < EPS);
  const rights = pieces.filter((piece) => concerned(piece) && Math.abs(piece.at - time) < EPS);
  if (!lefts.length || lefts.length !== rights.length) return pieces;

  const pairs = new Map();
  for (const left of lefts) {
    const right = rights.find((piece) => piece.lane === left.lane);
    if (!right || Math.abs(right.from - left.to) > EPS || !soundsAlike(left, right)) {
      return pieces;
    }
    pairs.set(left, right);
  }
  const groups = new Map([...pairs].map(([left, right]) => [right.group, left.group]));
  const gone = new Set(pairs.values());
  return pieces.filter((piece) => !gone.has(piece)).map((piece) => {
    const merged = pairs.has(piece) ? { ...piece, to: pairs.get(piece).to } : piece;
    const follows = piece.at >= time - EPS && groups.has(piece.group);
    return follows ? { ...merged, group: groups.get(piece.group) } : merged;
  });
}

function restorePicture(pieces, part) {
  const { from, to, lanes } = part;
  const length = to - from;
  const { time, room } = placeOf(pieces, part);
  const reach = time + Math.min(room, length);
  const taken = pieces.some((p) => lanes.includes(p.lane) && p.at < reach - EPS && endOf(p) > time + EPS);

  let list = pieces;
  if (taken) list = insertSpace(pieces, time, length);
  else if (room < length - EPS) list = insertSpace(pieces, time + room, length - room);

  const next = counters(list);
  const group = next.group();
  const added = lanes.flatMap((lane) => {
    const ranges = lane === VIDEO ? [[from, to]] : subtract([[from, to]], played(pieces, lane)).filter(longEnough);
    return ranges.map(([a, b]) => ({
      id: next.id(), group, lane, at: time + a - from, from: a, to: b, speed: 1, muted: false,
    }));
  });
  return { pieces: join(join([...list, ...added], time + length), time), time };
}

/** Puts sound back under the picture it belongs to, where that place is free. */
function restoreSound(pieces, { from, to, lanes }) {
  const next = counters(pieces);
  let list = pieces;
  let time = Infinity;
  for (const lane of lanes) {
    for (const picture of onLane(pieces, VIDEO)) {
      const a = Math.max(from, picture.from);
      const b = Math.min(to, picture.to);
      if (b - a < SHORTEST) continue;
      const wanted = [a, b].map((x) => picture.at + (x - picture.from) / picture.speed);
      const free = subtract([wanted], onLane(list, lane).map((p) => [p.at, endOf(p)])).filter(longEnough);
      for (const [start, end] of free) {
        const source = (x) => picture.from + (x - picture.at) * picture.speed;
        list = [...list, {
          id: next.id(),
          group: picture.group,
          lane,
          at: start,
          from: source(start),
          to: source(end),
          speed: picture.speed,
          muted: false,
        }];
        list = join(join(list, end, [lane]), start, [lane]);
        time = Math.min(time, start);
      }
    }
  }
  return { pieces: list, time };
}

/** Returns the new list and where the part now starts, or the same list when there is no room. */
export function restorePart(pieces, part) {
  return part.lanes.includes(VIDEO) ? restorePicture(pieces, part) : restoreSound(pieces, part);
}

export function restoreAll(pieces, clip) {
  let list = pieces;
  // The picture first: sound can only come back under it.
  for (const picture of [true, false]) {
    for (const part of removedParts(list, clip)) {
      if (part.lanes.includes(VIDEO) === picture) list = restorePart(list, part).pieces;
    }
  }
  return list;
}
