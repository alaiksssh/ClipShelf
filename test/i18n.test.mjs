import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DICTIONARIES, LANGUAGES, translator, languageOf } from '../src/shared/i18n.mjs';
import { AGES } from '../src/shared/storage.mjs';
import { MARK_COLORS, KINDS } from '../src/shared/moments.mjs';

const { en } = DICTIONARIES;
const placeholders = (text) => [...JSON.stringify(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const shape = (text) => (typeof text === 'object' ? Object.keys(text).sort().join() : 'text');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sources(file);
    return /\.(m?js|html)$/.test(entry.name) ? [fs.readFileSync(file, 'utf8')] : [];
  });
}
const code = sources(path.resolve('src')).join('\n');

test('English is the default, an unknown language gives English', () => {
  assert.equal(translator().language, 'en');
  assert.equal(languageOf('xx'), 'en');
  assert.equal(translator('fr').language, 'fr');
  assert.deepEqual(LANGUAGES.map((language) => language.id).sort(), Object.keys(DICTIONARIES).sort());
});

test('every language has the keys, plural forms and placeholders of English', () => {
  for (const [id, words] of Object.entries(DICTIONARIES)) {
    assert.deepEqual(Object.keys(words).sort(), Object.keys(en).sort(), id);
    for (const [key, text] of Object.entries(en)) {
      assert.equal(shape(words[key]), shape(text), `${id} ${key}`);
      assert.deepEqual(placeholders(words[key]), placeholders(text), `${id} ${key}`);
    }
  }
});

test('plurals, placeholders and numbers follow the language', () => {
  const english = translator('en');
  const french = translator('fr');
  assert.equal(english.t('lib.clipCount', { count: 1 }), '1 clip');
  assert.equal(english.t('lib.clipCount', { count: 0 }), '0 clips');
  assert.equal(french.t('lib.clipCount', { count: 0 }), '0 clip'); // French counts 0 as one.
  assert.equal(french.t('lib.selected', { count: 2 }), '2 sélectionnés');
  assert.equal(english.bytes(12.3e6), '12 MB');
  assert.equal(french.bytes(2.5e6), '2,5 Mo');
  assert.equal(english.bytes(1.25e9), '1.3 GB');
  assert.equal(english.t('no.such.key'), 'no.such.key');
  assert.equal(english.t('track.n'), 'Track {n}'); // A missing value stays visible.
});

test('every key the code asks for exists', () => {
  const used = new Set();
  for (const match of code.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(match[1]);
  for (const match of code.matchAll(/\bt\([^()']*\?\s*'([\w.]+)'\s*:\s*'([\w.]+)'/g)) used.add(match[1]).add(match[2]);
  for (const match of code.matchAll(/\bkey: '([\w.]+)'/g)) used.add(match[1]);
  for (const match of code.matchAll(/data-i18n(?:-title)?="([\w.]+)"/g)) used.add(match[1]);
  for (const age of AGES) used.add(`age.${age.id}`);
  for (const color of MARK_COLORS) used.add(`color.${color}`);
  for (const kind of Object.values(KINDS)) used.add(kind.name);
  const missing = [...used].filter((key) => !Object.hasOwn(en, key));
  assert.deepEqual(missing, []);
});

test('no key of the dictionaries is left unused', () => {
  const unused = Object.keys(en).filter((key) => !code.includes(`'${key}'`) && !code.includes(`"${key}"`)
    && !/^(age|color)\./.test(key));
  assert.deepEqual(unused, []);
});
