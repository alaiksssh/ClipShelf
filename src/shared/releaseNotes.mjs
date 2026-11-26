// The news of a downloaded update, read from the notes of its GitHub release. publish.cjs writes one
// list per language under these headings; GitHub gives them back as HTML, a file as Markdown.
export const HEADINGS = { fr: 'Nouveautés', en: "What's new" };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text of a piece of HTML: no tags, entities decoded, spaces squeezed. */
function plain(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** [{ heading, items }] in the order of the notes. Items before any heading have an empty heading. */
function sections(text) {
  const found = [{ heading: '', items: [] }];
  const parts = /<(h\d|li)\b/i.test(text)
    ? [...text.matchAll(/<(h\d)[^>]*>([\s\S]*?)<\/\1>|<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => (m[1] ? { heading: m[2] } : { item: m[3] }))
    : text.split(/\r?\n/).map((line) => {
      const heading = /^\s*#+\s+(.*)$/.exec(line);
      if (heading) return { heading: heading[1] };
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      return item ? { item: item[1] } : null;
    }).filter(Boolean);
  for (const part of parts) {
    if (part.heading !== undefined) found.push({ heading: plain(part.heading), items: [] });
    else {
      const item = plain(part.item);
      if (item) found.at(-1).items.push(item);
    }
  }
  return found.filter((section) => section.items.length);
}

/**
 * The news to show in `language`: the list under its heading, else the first list, else none.
 * `notes` is what electron-updater gives: a string, or a list of { version, note }.
 */
export function notesFor(notes, language) {
  // A list holds every version since the one running, the newest first: its news are the ones shown.
  const text = Array.isArray(notes) ? notes[0]?.note || '' : String(notes || '');
  const found = sections(text);
  const heading = HEADINGS[language];
  const mine = found.find((section) => heading && section.heading.toLowerCase().includes(heading.toLowerCase()));
  return (mine || found[0])?.items ?? [];
}
