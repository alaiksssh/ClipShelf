import { plain } from '/shared/search.mjs';
import { pickTint, tintCss } from '/shared/tint.mjs';
import { h, icon } from './dom.js';

const SIZE = 32; // Pixels read to find the colour of a logo.
const tints = new Map(); // Address of a logo -> colour, or null.

// The same name as gameIcons.js gives to a logo.
const slugOf = (name) => plain(String(name).normalize('NFKD')).replace(/[^\p{L}\p{N}]/gu, '');

function readTint(img) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(img, 0, 0, SIZE, SIZE);
  const tint = pickTint(context.getImageData(0, 0, SIZE, SIZE).data);
  return tint && tintCss(tint);
}

/**
 * The logo of a game, or the controller while there is none.
 * `onTint` receives the colour of the logo, at once when it is already known.
 */
export function gameBadge(name, logos = {}, onTint = () => {}) {
  const slug = slugOf(name);
  const fallback = () => h('span', { class: 'badge-icon' }, icon('game'));
  if (!Object.hasOwn(logos, slug)) return fallback();
  const src = `/logo/${encodeURIComponent(slug)}?${logos[slug]}`;
  // After the caller has its element: it is often still being built.
  if (tints.get(src)) queueMicrotask(() => onTint(tints.get(src)));
  const badge = h('span', { class: 'badge-icon logo' });
  badge.append(h('img', {
    src,
    alt: '',
    draggable: 'false',
    onLoad: (event) => {
      // Another copy of this logo may have been read meanwhile.
      if (tints.has(src)) {
        if (tints.get(src)) onTint(tints.get(src));
        return;
      }
      let tint = null;
      try {
        tint = readTint(event.target);
      } catch {
        // An image the canvas cannot read keeps the colour of the list.
      }
      tints.set(src, tint);
      if (tint) onTint(tint);
    },
    onError: () => badge.replaceWith(fallback()),
  }));
  return badge;
}
