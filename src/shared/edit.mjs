// A saved edit: { version: 2, pieces, tracks, ratio, position, zone }.
// `zone` is [start, end] in the montage, or null: what playback, export and overwrite keep.
import { RATIOS, clamp, cropRect } from './geometry.mjs';
import { cleanTransition, blendsPicture } from './transitions.mjs';
import { VIDEO, MIN_SPEED, MAX_SPEED, MAX_PIECE_VOLUME, MIN_LENGTH, EPS, muteRange, hasOverlap, pieceAt, sourceAt, totalLength, copySpan, onLane } from './pieces.mjs';

export const VERSION = 2;
export const MAX_VOLUME = 2;

export function defaultTracks(count, analysis) {
  return Array.from({ length: count }, (_, i) => ({
    on: analysis?.tracks[i]?.on ?? i === 0,
    solo: false,
    volume: 1,
    name: '',
  }));
}

function linkedSpans(spans, trackCount) {
  let id = 0;
  return spans.flatMap(({ at, from, to, speed }, index) =>
    Array.from({ length: trackCount + 1 }, (_, i) => ({
      id: (id += 1), group: index + 1, lane: i + VIDEO, at, from, to, speed, muted: false, volume: 1,
    })));
}

export function createEdit(clip, analysis) {
  return {
    version: VERSION,
    pieces: linkedSpans([{ at: 0, from: 0, to: clip.duration, speed: 1 }], clip.audio.length),
    tracks: defaultTracks(clip.audio.length, analysis),
    ratio: 'original',
    position: 0.5,
    zone: null,
  };
}

/** Version 1 stored ordered { a, b, speed } segments, with muted zones in source time. */
function fromVersion1(edit, clip) {
  let at = 0;
  const spans = edit.segments.map(({ a, b, speed = 1 }) => {
    const span = { at, from: a, to: b, speed };
    at += (b - a) / speed;
    return span;
  });
  let pieces = linkedSpans(spans, clip.audio.length);

  (edit.tracks || []).forEach((track, lane) => {
    for (const [from, to] of track.mutes || []) {
      for (const span of spans) {
        const a = Math.max(from, span.from);
        const b = Math.min(to, span.to);
        if (b - a < EPS) continue;
        const toMontage = (time) => span.at + (time - span.from) / span.speed;
        pieces = muteRange(pieces, [lane], [toMontage(a), toMontage(b)]);
      }
    }
  });
  return pieces;
}

/** The transitions a saved piece holds, checked, added to its clean copy. */
function withTransitions(saved, piece) {
  const lane = Number(saved.lane);
  for (const key of ['transitionIn', 'transitionOut']) {
    const value = cleanTransition(saved[key], lane);
    if (value) piece[key] = value;
  }
  return piece;
}

/** Turns anything saved or received into a valid edit of the current version. */
export function loadEdit(saved, clip) {
  const base = createEdit(clip);
  if (!saved || typeof saved !== 'object') return base;

  let raw = null;
  if (saved.version === VERSION && Array.isArray(saved.pieces)) raw = saved.pieces;
  else if (Array.isArray(saved.segments) && saved.segments.length) raw = fromVersion1(saved, clip);

  const pieces = (raw || base.pieces).map((piece, i) => withTransitions(piece, {
    id: Number.isSafeInteger(piece.id) ? piece.id : i + 1,
    group: Number.isSafeInteger(piece.group) ? piece.group : i + 1,
    lane: Number(piece.lane),
    at: Math.max(0, Number(piece.at)),
    from: clamp(Number(piece.from), 0, clip.duration),
    to: clamp(Number(piece.to), 0, clip.duration),
    speed: clamp(Number(piece.speed) || 1, MIN_SPEED, MAX_SPEED),
    muted: piece.muted === true,
    volume: Number.isFinite(piece.volume) ? clamp(piece.volume, 0, MAX_PIECE_VOLUME) : 1,
  })).filter((piece) => Number.isInteger(piece.lane) && piece.lane >= VIDEO && piece.lane < clip.audio.length
    && Number.isFinite(piece.at) && piece.to - piece.from > EPS);

  const usable = pieces.some((piece) => piece.lane === VIDEO) && !hasOverlap(pieces);
  return {
    version: VERSION,
    pieces: usable ? pieces : base.pieces,
    tracks: base.tracks.map((track, i) => {
      const own = saved.tracks?.[i] || {};
      return {
        on: typeof own.on === 'boolean' ? own.on : track.on,
        solo: own.solo === true,
        volume: Number.isFinite(own.volume) ? clamp(own.volume, 0, MAX_VOLUME) : 1,
        name: typeof own.name === 'string' ? own.name.slice(0, 40) : '',
      };
    }),
    ratio: Object.hasOwn(RATIOS, saved.ratio) ? saved.ratio : 'original',
    position: Number.isFinite(saved.position) ? clamp(saved.position, 0, 1) : 0.5,
    zone: Array.isArray(saved.zone) && saved.zone.every(Number.isFinite) && saved.zone[1] > saved.zone[0]
      ? [Math.max(0, saved.zone[0]), saved.zone[1]]
      : null,
  };
}

/** Whether each track is heard, solo taken into account. */
export function audibleTracks(tracks) {
  const soloed = tracks.some((track) => track.solo);
  return tracks.map((track) => (soloed ? track.solo : track.on) && track.volume > 0);
}

/** Fast export needs an uncut picture; audio may be edited as long as it plays in place. */
export function canCopyVideo(edit) {
  const video = edit.pieces.filter((piece) => piece.lane === VIDEO);
  if (video.length !== 1 || edit.ratio !== 'original' || blendsPicture(edit.pieces)) return false;
  const [only] = video;
  if (only.at > EPS || only.speed !== 1) return false;
  return edit.pieces.every((piece) => {
    if (piece === only) return true;
    const picture = pieceAt(edit.pieces, VIDEO, piece.at);
    return picture && piece.speed === 1
      && Math.abs(sourceAt(picture, piece.at) - piece.from) < 0.01
      && piece.to <= only.to + 0.01;
  });
}

/** The zone of an edit, kept within its montage, or null when there is none. */
export function zoneOf(edit) {
  if (!Array.isArray(edit?.zone)) return null;
  const length = totalLength(edit.pieces);
  const start = clamp(edit.zone[0], 0, length);
  const end = clamp(edit.zone[1], 0, length);
  if (end - start < MIN_LENGTH || (start < EPS && end > length - EPS)) return null;
  return [start, end];
}

/** What is exported or saved: the zone only, starting at zero. */
export function outputEdit(edit) {
  const zone = zoneOf(edit);
  return zone ? { ...edit, pieces: copySpan(edit.pieces, zone), zone: null } : { ...edit, zone: null };
}

/**
 * What the preview of a card plays for a saved edit: the pictures of what would be exported, in
 * order, as runs of the file at their speed, and the frame they are cut to. Runs that follow each
 * other in the file are joined, so the preview only seeks at real cuts. Null when the picture is
 * the file as it was recorded.
 */
export function previewOf(saved, clip) {
  if (!saved) return null;
  const edit = outputEdit(loadEdit(saved, clip));
  const runs = [];
  for (const piece of onLane(edit.pieces, VIDEO)) {
    if (piece.muted) continue; // Black in an export.
    const last = runs.at(-1);
    if (last && last.speed === piece.speed && Math.abs(last.to - piece.from) < 0.01) last.to = piece.to;
    else runs.push({ from: piece.from, to: piece.to, speed: piece.speed });
  }
  const crop = cropRect(clip.width, clip.height, edit.ratio, edit.position);
  const [only] = runs;
  const whole = runs.length === 1 && only.speed === 1 && only.from < 0.01 && only.to > clip.duration - 0.01;
  return runs.length && (crop || !whole) ? { runs, crop } : null;
}
