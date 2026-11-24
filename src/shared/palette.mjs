// The order of the command palette: what matches every word typed, the best matches first.
// An item is { label, keywords, weight, needsQuery }: `keywords` are searched too but not shown,
// a lower `weight` comes first among equal matches, and `needsQuery` items wait for a word.
import { plain } from './search.mjs';

/** How well `label` matches the words typed: 0 when it starts with them, then 1, 2 and 3. */
function closeness(label, words) {
  const full = words.join(' ');
  if (label.startsWith(full)) return 0;
  if (label.split(/[\s:·#()_-]+/).some((part) => part.startsWith(words[0]))) return 1;
  if (label.includes(full)) return 2;
  return 3;
}

export function rankItems(items, query, limit = 40) {
  const words = plain(query).split(/\s+/).filter(Boolean);
  const found = [];
  items.forEach((item, index) => {
    if (item.needsQuery && !words.length) return;
    const label = plain(item.label);
    const text = `${label} ${plain(item.keywords || '')}`;
    if (!words.every((word) => text.includes(word))) return;
    const score = (words.length ? closeness(label, words) : 0) * 10 + (item.weight || 0);
    found.push({ item, score, index });
  });
  return found.sort((a, b) => a.score - b.score || a.index - b.index).slice(0, limit).map(({ item }) => item);
}
