// What a file made of parts of other clips keeps of what the user gave them: names, tags, marks,
// kills, rounds and montage. Used when replays that share pictures are joined or cut.
//
// A part is { meta, clip, from, to, shift }: the times [from, to) of the file of `clip` go into the
// new file, where a time t of that file is t + shift. Kills, deaths and rounds come from these
// times only, so that a moment held by two parts is counted once. Marks were put by hand: each one
// is kept wherever it lands in the new file.
import { VIDEO, EPS, MIN_LENGTH, endOf, totalLength, hasOverlap, soundsAlike } from './pieces.mjs';
import { VERSION, createEdit, loadEdit, zoneOf } from './edit.mjs';
import { MARK_COLORS } from './moments.mjs';

const SAME_MARK = 0.5; // Seconds: two marks this close are the same moment, put in both files.

/** Favourite if any was, and the first name, folder, game and capture found. Tags of all. */
export function joinDetails(metas) {
  const all = metas.map((meta) => meta || {});
  const first = (field) => all.map((meta) => meta[field]).find((value) => value !== undefined && value !== '');
  const details = {
    favorite: all.some((meta) => meta.favorite),
    hideTallies: all.some((meta) => meta.hideTallies),
    tags: [...new Set(all.flatMap((meta) => meta.tags || []))],
  };
  for (const field of ['title', 'category', 'game', 'capturedGame', 'capturedProcess']) {
    const value = first(field);
    if (value !== undefined) details[field] = value;
  }
  return details;
}

/** A colour for a new mark, unlike that of the mark before it. */
function nextColor(items) {
  const last = items.filter((item) => item.kind === 'mark').at(-1)?.color;
  return MARK_COLORS[(MARK_COLORS.indexOf(last) + 1) % MARK_COLORS.length];
}

function withoutRepeats(items) {
  const kept = [];
  for (const item of [...items].sort((a, b) => a.time - b.time)) {
    const twin = item.kind === 'mark' && kept.find((other) => other.kind === 'mark'
      && Math.abs(other.time - item.time) < SAME_MARK && (!item.name || other.name === item.name));
    if (!twin) kept.push(item);
  }
  return kept.map((item, i) => ({ ...item, id: i + 1 }));
}

/**
 * The moments of the new file. `saves` are marks to add: [{ time, name }], where a replay that no
 * longer has a file of its own was saved, so that the moment the user saved it for stays visible.
 */
export function joinMoments(parts, { length = Infinity, saves = [] } = {}) {
  const owned = parts.filter((part) => part.meta?.moments);
  if (!owned.length && !saves.length) return undefined;
  const items = [];
  for (const { meta, from, to, shift } of owned) {
    for (const moment of meta.moments.items || []) {
      const time = moment.time + shift;
      if (moment.kind === 'mark' ? time >= 0 && time <= length : moment.time >= from && moment.time < to) {
        items.push({ ...moment, time });
      }
    }
  }
  for (const save of saves) {
    if (save.time < 0 || save.time > length) continue;
    items.push({ kind: 'mark', time: save.time, name: save.name || '', color: nextColor(items) });
  }

  // Detected only when every part was: otherwise the detector reads the new file again.
  const detected = owned.length === parts.length ? Math.min(...owned.map(({ meta }) => meta.moments.detected || 0)) : 0;
  const counted = owned.length === parts.length && owned.every(({ meta }) => Array.isArray(meta.moments.rounds));
  const rounds = counted
    ? owned.flatMap(({ meta, from, to, shift }) => meta.moments.rounds.filter((time) => time >= from && time < to).map((time) => time + shift))
    : null;
  return {
    detected,
    replay: owned.some(({ meta }) => meta.moments.replay),
    items: withoutRepeats(items),
    rounds,
  };
}

/** The pieces that play the times [from, to) of the file, cut where they cross the edges. */
function restrict(pieces, from, to) {
  return pieces.flatMap((piece) => {
    const a = Math.max(from, piece.from);
    const b = Math.min(to, piece.to);
    if (b - a < EPS) return [];
    return [{ ...piece, at: piece.at + (a - piece.from) / piece.speed, from: a, to: b }];
  });
}

/**
 * Removes the empty time left between pictures where pieces were taken out, and returns where each
 * former time of the montage now is. A time in such a gap goes to where the gap was.
 */
function closeGaps(pieces) {
  const spans = [];
  for (const piece of pieces.filter((p) => p.lane === VIDEO).sort((a, b) => a.at - b.at)) {
    const last = spans.at(-1);
    if (last && piece.at <= last[1] + EPS) last[1] = Math.max(last[1], endOf(piece));
    else spans.push([piece.at, endOf(piece)]);
  }
  const move = (time) => {
    let removed = 0;
    for (const [k, [start, stop]] of spans.entries()) {
      if (k > 0) {
        if (time < start) return Math.min(time, spans[k - 1][1]) - removed;
        removed += start - spans[k - 1][1];
      }
      if (time <= stop) return time - removed;
    }
    return time - removed;
  };
  return { pieces: pieces.map((piece) => ({ ...piece, at: move(piece.at) })), move };
}

/** Linked groups that follow each other, in the montage and in the file, on every lane, become one. */
function coalesce(pieces) {
  const byGroup = new Map();
  for (const piece of pieces) byGroup.set(piece.group, [...(byGroup.get(piece.group) || []), { ...piece }]);
  const follows = (left, right) => left.length === right.length && left.every((a) => {
    const b = right.find((piece) => piece.lane === a.lane);
    return b && Math.abs(endOf(a) - b.at) < EPS && Math.abs(a.to - b.from) < EPS && soundsAlike(a, b);
  });
  for (let joined = true; joined;) {
    joined = false;
    for (const [group, left] of byGroup) {
      const next = [...byGroup].find(([other, right]) => other !== group && follows(left, right));
      if (!next) continue;
      for (const piece of left) {
        const right = next[1].find((other) => other.lane === piece.lane);
        piece.to = right.to;
        if (right.transitionOut) piece.transitionOut = right.transitionOut;
      }
      byGroup.delete(next[0]);
      joined = true;
      break;
    }
  }
  return [...byGroup.values()].flat();
}

/**
 * The montage of the new file, or null when no part had one. Each part brings the montage it had
 * for its own times, one after the other; a part without a montage brings its times whole.
 * `clip` is the new file: { duration, audio }.
 */
export function joinEdit(parts, clip) {
  const edited = parts.filter((part) => part.meta?.edit);
  if (!edited.length) return null;
  const firstEdit = loadEdit(edited[0].meta.edit, edited[0].clip);
  const cropped = edited.map((part) => loadEdit(part.meta.edit, part.clip)).find((edit) => edit.ratio !== 'original');

  const pieces = [];
  const zones = [];
  let cursor = 0;
  let ids = 0;
  let groups = 0;
  for (const part of parts) {
    const edit = loadEdit(part.meta?.edit, part.clip);
    let own = closeGaps(restrict(edit.pieces, part.from, part.to));
    // A montage whose sound pieces no longer fit once cut keeps its times whole instead.
    if (hasOverlap(own.pieces)) own = closeGaps(restrict(createEdit(part.clip).pieces, part.from, part.to));
    const video = own.pieces.filter((piece) => piece.lane === VIDEO);
    if (!video.length) continue;
    const begin = Math.min(...video.map((piece) => piece.at));
    const place = (time) => time - begin + cursor;
    for (const piece of own.pieces) {
      pieces.push({
        ...piece,
        id: piece.id + ids,
        group: piece.group + groups,
        at: Math.max(cursor, place(piece.at)),
        from: piece.from + part.shift,
        to: piece.to + part.shift,
      });
    }
    const length = totalLength(own.pieces) - begin;
    const zone = zoneOf(edit);
    if (zone) {
      const start = Math.max(cursor, place(own.move(zone[0])));
      const end = Math.min(cursor + length, place(own.move(zone[1])));
      if (end - start >= MIN_LENGTH) zones.push([start, end]);
    }
    ids += Math.max(0, ...own.pieces.map((piece) => piece.id));
    groups += Math.max(0, ...own.pieces.map((piece) => piece.group));
    cursor += length;
  }

  return loadEdit({
    version: VERSION,
    pieces: coalesce(pieces),
    tracks: firstEdit.tracks,
    ratio: cropped?.ratio || 'original',
    position: cropped?.position ?? firstEdit.position,
    zone: zones.length ? [zones[0][0], zones.at(-1)[1]] : null,
  }, clip);
}

/** Marks of a clip that goes away, placed in the clip that holds its pictures. */
export function marksInto(moments, marks, { length = Infinity } = {}) {
  const items = [...(moments?.items || [])];
  for (const mark of marks) {
    if (mark.time < 0 || mark.time > length) continue;
    items.push({ kind: 'mark', time: mark.time, name: mark.name || '', color: mark.color || nextColor(items) });
  }
  return { ...(moments || {}), items: withoutRepeats(items) };
}

/**
 * The picture chosen for the card of the new file, as a time of that file. Each part may have one
 * (`meta.thumb`, a time of its own file); the last part whose choice it keeps wins, as the new file
 * takes the name and place of the last replay. Undefined when no part keeps one.
 */
export function joinThumb(parts) {
  for (const { meta, from = 0, to = Infinity, shift = 0 } of [...parts].reverse()) {
    const time = meta?.thumb;
    if (Number.isFinite(time) && time >= from && time < to) return time + shift;
  }
  return undefined;
}
