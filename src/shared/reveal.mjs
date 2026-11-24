// Pulling an edge outwards gives back what was cut there, like in editing software.
//
// It stops where the montage already plays that part of the clip, so reaching the stop puts back
// exactly what was deleted, and the cut closes. On the picture the rest is pushed, after filling
// whatever hole there was. A track pulled on its own only fills holes, so it can't lose sync.
import { VIDEO, EPS, counters, endOf, insertSpace, lengthOf, onLane } from './pieces.mjs';
import { SHORTEST, join, longEnough, played, subtract } from './restore.mjs';

const edgeTime = (piece, edge) => (edge === 'start' ? piece.at : endOf(piece));
const edgeSource = (piece, edge) => (edge === 'start' ? piece.from : piece.to);

const inSync = (a, b, edge) => Math.abs(edgeTime(a, edge) - edgeTime(b, edge)) < EPS
  && Math.abs(edgeSource(a, edge) - edgeSource(b, edge)) < 0.01
  && Math.abs(a.speed - b.speed) < EPS;

/** Seconds of the clip beyond an edge, up to what its lane already plays or the end of the clip. */
function hiddenBeyond(pieces, piece, edge, duration, beyond) {
  const isStart = edge === 'start';
  let limit = isStart ? 0 : duration;
  if (!beyond) {
    for (const other of pieces) {
      if (other.lane !== piece.lane || other === piece) continue;
      if (isStart && other.from < piece.from - EPS) limit = Math.max(limit, Math.min(other.to, piece.from));
      if (!isStart && other.to > piece.to + EPS) limit = Math.min(limit, Math.max(other.from, piece.to));
    }
  }
  return isStart ? piece.from - limit : limit - piece.to;
}

/** The empty time just outside an edge. */
function roomBeside(pieces, piece, edge) {
  const time = edgeTime(piece, edge);
  let limit = edge === 'start' ? 0 : Infinity;
  for (const other of pieces) {
    if (other.lane !== piece.lane || other === piece) continue;
    if (edge === 'start' && other.at < time - EPS) limit = Math.max(limit, Math.min(endOf(other), time));
    if (edge === 'end' && endOf(other) > time + EPS) limit = Math.min(limit, Math.max(other.at, time));
  }
  return edge === 'start' ? time - limit : limit - time;
}

/**
 * What pulling this edge outwards can give back. `max` is in seconds of montage.
 * `blocked` means that there is hidden content, but no place for it.
 */
export function planReveal(pieces, piece, edge, { clip, linked, beyond = false }) {
  const hiddenOf = (p) => hiddenBeyond(pieces, p, edge, clip.duration, beyond) / p.speed;
  let anchor = piece;
  if (linked && piece.lane !== VIDEO) {
    const picture = pieces.find((p) => p.lane === VIDEO && inSync(p, piece, edge));
    // Without hidden picture, the track may still have a hole of its own to fill.
    if (picture && hiddenOf(picture) >= SHORTEST) anchor = picture;
  }
  const picture = anchor.lane === VIDEO;
  const members = picture && linked
    ? pieces.filter((p) => p === anchor || (p.lane !== VIDEO && inSync(p, anchor, edge)))
    : [anchor];

  const hidden = hiddenOf(anchor);
  const room = Math.max(0, Math.min(...members.map((p) => roomBeside(pieces, p, edge))));
  const possible = picture ? hidden : Math.min(hidden, room);
  return {
    clip,
    anchor,
    edge,
    linked,
    picture,
    members,
    room,
    time: edgeTime(anchor, edge),
    max: possible >= SHORTEST ? possible : 0,
    blocked: hidden >= SHORTEST && possible < SHORTEST,
  };
}

/**
 * Pulls an edge by `amount` seconds of montage.
 * Returns the list, how much of it was pushed, and where the pulled edge now is.
 */
export function reveal(pieces, plan, amount) {
  const { anchor, edge, members, time, room, max } = plan;
  if (amount < EPS) return { pieces, push: 0, time };
  const isStart = edge === 'start';
  const length = Math.min(amount, max);
  const used = Math.min(room, length);
  const push = length - used < EPS ? 0 : length - used;

  let list = push ? insertSpace(pieces, isStart ? time : time + used, push) : pieces;
  const from = isStart ? time - used : time;
  const to = from + length;
  const ids = new Set(members.map((p) => p.id));
  list = list.map((p) => {
    if (!ids.has(p.id)) return p;
    return isStart
      ? { ...p, at: Math.max(0, p.at - length), from: Math.max(0, p.from - length * p.speed) }
      : { ...p, to: Math.min(plan.clip.duration, p.to + length * p.speed) };
  });

  if (plan.picture && plan.linked) {
    // Lanes without sound at this edge get back what is played nowhere else.
    const grown = list.find((p) => p.id === anchor.id);
    const source = (t) => grown.from + (t - grown.at) * grown.speed;
    const montage = (s) => grown.at + (s - grown.from) / grown.speed;
    const next = counters(list);
    for (let lane = 0; lane < plan.clip.audio.length; lane += 1) {
      if (members.some((p) => p.lane === lane)) continue;
      const unplayed = subtract([[source(from), source(to)]], played(pieces, lane)).filter(longEnough);
      for (const [a, b] of unplayed) {
        const free = subtract([[montage(a), montage(b)]], onLane(list, lane).map((p) => [p.at, endOf(p)]));
        for (const [start, end] of free.filter(longEnough)) {
          list = join(join([...list, {
            id: next.id(),
            group: grown.group,
            lane,
            at: start,
            from: source(start),
            to: source(end),
            speed: grown.speed,
            muted: false,
          }], end, [lane]), start, [lane]);
        }
      }
    }
  }

  if (length >= max - EPS) list = join(list, isStart ? from : to, plan.picture ? undefined : [anchor.lane]);
  return { pieces: list, push, time: isStart ? from : to };
}

/**
 * The handles drawn on the picture where something was cut.
 * A cut has one handle for both sides: pulled left it uses `start`, pulled right `end`.
 */
export function seamsOf(pieces, clip, linked = true) {
  const video = onLane(pieces, VIDEO);
  const planOf = (piece, edge) => planReveal(pieces, piece, edge, { clip, linked });
  const seams = [];
  let shared = false;
  video.forEach((piece, i) => {
    if (!shared) {
      const { max } = planOf(piece, 'start');
      if (max) seams.push({ at: piece.at, start: piece, seconds: max * piece.speed });
    }
    shared = false;

    const { max } = planOf(piece, 'end');
    if (!max) return;
    const seconds = max * piece.speed;
    const next = video[i + 1];
    if (next && Math.abs(next.at - endOf(piece)) < EPS && Math.abs(next.from - piece.to - seconds) < 0.01) {
      shared = planOf(next, 'start').max > 0;
    }
    seams.push({ at: endOf(piece), end: piece, ...(shared && { start: next }), seconds });
  });
  return seams;
}

/** Deleted sound, as pieces lying where they would come back. */
export function soundHoles(pieces, clip, lane) {
  const own = played(pieces, lane);
  const taken = onLane(pieces, lane).map((p) => [p.at, endOf(p)]);
  return onLane(pieces, VIDEO).flatMap((picture) => {
    const toMontage = (s) => picture.at + (s - picture.from) / picture.speed;
    const toSource = (t) => picture.from + (t - picture.at) * picture.speed;
    const missing = subtract([[picture.from, picture.to]], own).filter(longEnough);
    const free = subtract(missing.map(([a, b]) => [toMontage(a), toMontage(b)]), taken);
    return free
      .map(([a, b]) => ({ lane, at: a, from: toSource(a), to: toSource(b), speed: picture.speed, muted: false }))
      .filter((hole) => lengthOf(hole) >= SHORTEST);
  });
}
