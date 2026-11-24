// The languages of the interface. The main process loads this file too, with require().
import en from './locales/en.mjs';
import fr from './locales/fr.mjs';

export const DICTIONARIES = { en, fr };
/** Each language under its own name, as the language setting lists them. */
export const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];
export const DEFAULT_LANGUAGE = 'en';

export const languageOf = (id) => (Object.hasOwn(DICTIONARIES, id) ? id : DEFAULT_LANGUAGE);

/**
 * The texts of one language. A text is a string, or an object of plural forms chosen with
 * `params.count`. `{name}` takes the value of `params.name`. A key the language lacks falls back to
 * English, and an unknown key shows as itself, so a forgotten text is seen at once.
 */
export function translator(id) {
  const language = languageOf(id);
  const words = DICTIONARIES[language];
  const plurals = new Intl.PluralRules(language);
  const numbers = new Map();

  const t = (key, params = {}) => {
    let text = words[key] ?? en[key];
    if (text === undefined) return key;
    if (typeof text === 'object') text = text[plurals.select(params.count ?? 0)] ?? text.other;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
  };

  /** A number with a fixed count of decimals, as the language writes it: 8.1 or 8,1. */
  const decimal = (value, digits = 1) => {
    if (!numbers.has(digits)) {
      numbers.set(digits, new Intl.NumberFormat(language, {
        minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false,
      }));
    }
    return numbers.get(digits).format(value);
  };

  /** A file size: a decimal under 10 MB, whole megabytes above, then GB and TB. */
  const bytes = (value) => {
    if (value >= 1e12) return t('unit.tb', { n: decimal(value / 1e12) });
    if (value >= 1e9) return t('unit.gb', { n: decimal(value / 1e9) });
    if (value >= 1e7) return t('unit.mb', { n: Math.round(value / 1e6) });
    return t('unit.mb', { n: decimal(value / 1e6) });
  };

  return { language, t, decimal, bytes };
}
