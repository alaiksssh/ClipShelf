// The parts of a tooltip text: what it says, and the shortcut it ends with in brackets, such as
// "Exporter (Ctrl+E)". Brackets that hold anything else, like "(AMD)", stay in the text.

// A key or a combination: "Ctrl+E", "Ctrl+←", "F2", "T", "0", "Échap", "Suppr", "Esc", "Del".
const KEY = /^(?:(?:Ctrl|Maj|Shift|Alt)\s?\+\s?\S+|Échap|Esc|Suppr|Del|Delete|Entrée|Enter|Espace|Space|Tab|F\d{1,2}|[A-Z0-9]|[←→↑↓])$/;

/** The text and the shortcut of a tooltip; the lines after the first one are details. */
export function splitTip(text) {
  const [first, ...rest] = String(text).split(/\r?\n/);
  const match = /^(.*\S)\s+\(([^()]+)\)$/.exec(first);
  const key = match && KEY.test(match[2]) ? match[2] : '';
  return { label: key ? match[1] : first, key, details: rest.filter(Boolean) };
}
