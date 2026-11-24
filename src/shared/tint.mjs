// The colour of a logo, for the button of its game: the main colour, or the next one when the main
// one is muddy, too dark or greyish. Works on RGBA pixels, so it can be tested without a browser.
const BINS = 24; // Of 15 degrees, red centred on the first.
const MIN_SHARE = 0.04; // Of the opaque pixels.

function hsl(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r / 255) h = ((g - b) / 255 / d) % 6;
  else if (max === g / 255) h = (b - r) / 255 / d + 2;
  else h = (r - g) / 255 / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** Muddy, too dark or greyish: not a colour to light a button with. */
function odd({ h, s, l }) {
  return s < 0.3 || l < 0.2 || l > 0.85
    || (h >= 15 && h <= 50 && l < 0.38) // Brown.
    || (h >= 20 && h <= 70 && s < 0.5); // Skin, olive, beige.
}

/** Returns { h, s, l } ready to show on a dark background, or null when the logo has no clear colour. */
export function pickTint(pixels) {
  const bins = Array.from({ length: BINS }, () => ({ count: 0, x: 0, y: 0, s: 0, l: 0 }));
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    opaque += 1;
    const [h, s, l] = hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (s < 0.22 || l < 0.12 || l > 0.92) continue; // Grey, black or white.
    const bin = bins[Math.floor(((h + 7.5) % 360) / (360 / BINS))];
    bin.count += 1;
    bin.x += Math.cos((h * Math.PI) / 180);
    bin.y += Math.sin((h * Math.PI) / 180);
    bin.s += s;
    bin.l += l;
  }
  if (!opaque) return null;
  const colours = bins
    .filter((bin) => bin.count / opaque >= MIN_SHARE)
    .sort((a, b) => b.count - a.count)
    .map((bin) => ({
      h: ((Math.atan2(bin.y, bin.x) * 180) / Math.PI + 360) % 360,
      s: bin.s / bin.count,
      l: bin.l / bin.count,
    }))
    .slice(0, 2);
  const chosen = colours.find((colour) => !odd(colour));
  if (!chosen) return null;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  return { h: Math.round(chosen.h), s: clamp(chosen.s * 1.1, 0.5, 0.9), l: clamp(chosen.l, 0.55, 0.68) };
}

export const tintCss = ({ h, s, l }) => `hsl(${h} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
