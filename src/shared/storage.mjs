// What takes room in the library, and what compressing it to H.265 would give back.

/** Codecs that H.265 would barely shrink: they are already as efficient. */
export const MODERN = new Set(['hevc', 'av1', 'vp9']);

/** Measured on real clips with the settings of the compressor: from 42 to 52 % of the size. */
export const RATIO = 0.5;

export const AGES = [
  { id: 'all', days: 0 },
  { id: 'week', days: 7 },
  { id: 'month', days: 30 },
  { id: 'quarter', days: 91 },
];

export function compressible(clip) {
  return !clip.busy && !clip.broken && Boolean(clip.codec) && !MODERN.has(clip.codec) && clip.size > 0;
}

export const estimateAfter = (clip) => Math.round(clip.size * RATIO);

export const olderThan = (clip, days, now = Date.now()) => !days || clip.date <= now - days * 864e5;

/** Sizes by game, largest first. Past `max` rows, the smallest games share the last one. */
export function byGame(clips, max = 6) {
  const totals = new Map();
  for (const clip of clips) {
    const total = totals.get(clip.game) || { game: clip.game, size: 0, count: 0 };
    total.size += clip.size;
    total.count += 1;
    totals.set(clip.game, total);
  }
  const sorted = [...totals.values()].sort((a, b) => b.size - a.size);
  if (sorted.length <= max) return sorted;
  const rest = sorted.slice(max - 1);
  return [...sorted.slice(0, max - 1), {
    game: null,
    games: rest.length,
    size: rest.reduce((sum, item) => sum + item.size, 0),
    count: rest.reduce((sum, item) => sum + item.count, 0),
  }];
}
