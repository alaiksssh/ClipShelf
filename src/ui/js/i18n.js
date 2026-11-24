import { translator } from '/shared/i18n.mjs';

// The main process opens the page with the language in its address and opens it again when the
// language changes, so every text can be built once with the right words.
const words = translator(new URLSearchParams(location.search).get('lang'));

export const { language, t, decimal, bytes } = words;
document.documentElement.lang = language;

/** Static texts of an HTML page: data-i18n names the key of the text, data-i18n-title that of the title. */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.dataset.tip = t(el.dataset.i18nTitle);
}
