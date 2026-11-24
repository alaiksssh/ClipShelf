// Moments are points in the file of a clip: { id, kind, time, name }. A montage shows those of the
// parts of the picture that it plays, as often as it plays them.
import { VIDEO } from './pieces.mjs';

export const NAME_LENGTH = 60;
export const KINDS = {
  kill: { name: 'kind.kill', icon: 'crosshair', color: 'ok' },
  death: { name: 'kind.death', icon: 'skull', color: 'low' },
  mark: { name: 'kind.mark', icon: 'flag', color: 'warn' },
};
const SAME_MOMENT = 1.5; // Seconds, between two readings of one clip.

/** Colours a mark can take, from the theme. */
export const MARK_COLORS = ['gpu', 'ram', 'cpu', 'net', 'disk', 'charge', 'warn', 'violet'];

export function colorOf(moment) {
  if (moment.kind === 'mark') return MARK_COLORS.includes(moment.color) ? moment.color : 'warn';
  return KINDS[moment.kind].color;
}

/** [{ id, moment, number, at }] in the order of the montage. `number` counts within a kind, in the file. */
export function placeMoments(moments, pieces) {
  const numbers = new Map();
  const numbered = [...moments].sort((a, b) => a.time - b.time).map((moment) => {
    numbers.set(moment.kind, (numbers.get(moment.kind) || 0) + 1);
    return { moment, number: numbers.get(moment.kind) };
  });
  const placed = [];
  for (const piece of pieces) {
    if (piece.lane !== VIDEO) continue;
    for (const { moment, number } of numbered) {
      if (moment.time < piece.from || moment.time >= piece.to) continue;
      placed.push({ id: moment.id, moment, number, at: piece.at + (moment.time - piece.from) / piece.speed });
    }
  }
  return placed.sort((a, b) => a.at - b.at);
}

/** Marks have no name until one is given. `t` gives the words of the interface: the name of a kind is a key. */
export function labelOf({ moment, number }, t = (key) => key) {
  if (moment.name || moment.kind === 'mark') return moment.name;
  return `${t(KINDS[moment.kind].name)} ${number}`;
}

/** The moments of the file that saving this montage produces. */
export function carryMoments(moments, pieces) {
  return placeMoments(moments, pieces).map(({ moment, at }, i) => ({ ...moment, id: i + 1, time: at }));
}

/**
 * Where a time of the file is in the file that saving this montage produces: the first place the
 * montage plays it. Undefined when the montage leaves it out, or when there is no time.
 */
export function carryTime(time, pieces) {
  if (!Number.isFinite(time)) return undefined;
  return placeMoments([{ kind: 'mark', time }], pieces)[0]?.at;
}

/**
 * `best` is the most kills within one round. Without rounds, as in Deathmatch, it is every kill.
 * `rounds` is where each round after the first starts, in the file.
 */
export function countMoments(moments, rounds = null) {
  const counts = { kill: 0, death: 0, mark: 0, best: 0 };
  const perRound = new Map();
  for (const { kind, time } of moments) {
    counts[kind] += 1;
    if (kind !== 'kill') continue;
    const round = roundOf(time, rounds) ?? 1;
    perRound.set(round, (perRound.get(round) || 0) + 1);
  }
  counts.best = Math.max(0, ...perRound.values());
  return counts;
}

/** The round of a time of the file, counted from 1 in the clip, or null without rounds. */
export function roundOf(time, rounds) {
  if (!Array.isArray(rounds)) return null;
  return 1 + rounds.filter((start) => start <= time + 0.01).length;
}

/** A multi-kill, as players say it. */
export function multiKill(best) {
  if (best >= 5) return 'ACE';
  return best >= 2 ? `${best}K` : '';
}

/** Where the rounds start in a montage: [{ at, number }]. */
export function placeRounds(rounds, pieces) {
  if (!Array.isArray(rounds)) return [];
  return placeMoments(rounds.map((time, i) => ({ id: i + 1, kind: 'round', time })), pieces)
    .map(({ at, moment }) => ({ at, number: moment.id + 1 }));
}

/** The starts of rounds in the file that saving this montage produces. */
export function carryRounds(rounds, pieces) {
  if (!Array.isArray(rounds)) return rounds ?? null;
  return placeRounds(rounds, pieces).map(({ at }) => at);
}

/** A new reading replaces what was detected, but keeps the marks and the names given by hand. */
export function mergeDetected(previous, events) {
  const named = previous.filter((moment) => moment.kind !== 'mark' && moment.name);
  const found = events.map(({ kind, time }) => {
    const index = named.findIndex((old) => old.kind === kind && Math.abs(old.time - time) <= SAME_MOMENT);
    const name = index < 0 ? '' : named.splice(index, 1)[0].name;
    return { kind, time, name };
  });
  return [...previous.filter((moment) => moment.kind === 'mark'), ...found]
    .sort((a, b) => a.time - b.time)
    .map((moment, i) => ({ ...moment, id: i + 1 }));
}
