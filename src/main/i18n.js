// The main process speaks the language of the interface: its errors and the lines of the export log
// are shown as they are. The translator is the one of the pages, loaded with require().
const { translator } = require('../shared/i18n.mjs');

let words = translator();

module.exports = {
  /** Takes the language of the settings; an unknown one gives the default. */
  setLanguage(id) {
    words = translator(id);
    return words.language;
  },
  language: () => words.language,
  t: (key, params) => words.t(key, params),
  decimal: (value, digits) => words.decimal(value, digits),
  bytes: (value) => words.bytes(value),
};
