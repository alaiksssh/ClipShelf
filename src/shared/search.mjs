// What the search bar understands: words, "#tag", "kill", "mort", "3k" (3 kills or more in one round), "ace".
import { countMoments } from './moments.mjs';

export const plain = (text) => String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Returns a test for clips. Every word of the query has to be found, in any of their fields. */
export function searcher(query, titleOf = (clip) => clip.title || clip.name) {
  const words = plain(query).split(/\s+/).filter((word) => word && word !== '#');
  if (!words.length) return () => true;

  return (clip) => {
    const counts = countMoments(clip.moments, clip.rounds);
    const tags = clip.tags.map(plain);
    const text = plain([
      clip.name,
      titleOf(clip),
      clip.game,
      clip.category,
      ...clip.tags,
      ...clip.moments.map((moment) => moment.name),
      counts.kill ? 'kills' : '',
      counts.death ? 'morts deaths' : '',
    ].join('\n'));

    return words.every((word) => {
      if (word.startsWith('#')) return tags.some((tag) => tag.includes(word.slice(1)));
      const atLeast = /^(\d{1,2})k$/.exec(word);
      if (atLeast && counts.best >= Number(atLeast[1])) return true;
      if (word === 'ace' && counts.best >= 5) return true;
      return text.includes(word);
    });
  };
}
