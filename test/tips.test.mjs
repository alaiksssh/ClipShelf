import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTip } from '../src/shared/tips.mjs';

test('a tooltip shows the shortcut its text ends with', () => {
  assert.deepEqual(splitTip('Exporter (Ctrl+E)'), { label: 'Exporter', key: 'Ctrl+E', details: [] });
  assert.deepEqual(splitTip('Retour (Échap)'), { label: 'Retour', key: 'Échap', details: [] });
  assert.equal(splitTip('Reculer de 5 secondes (Ctrl+←)').key, 'Ctrl+←');
  assert.equal(splitTip('Tout afficher (0)').key, '0');
  assert.equal(splitTip('Back (Esc)').key, 'Esc');
});

test('brackets that hold no shortcut stay in the text', () => {
  for (const text of ['Encodage sur la carte graphique (AMD)', 'Ace (5 dans un round)', 'Image par image (Maj : 1 seconde)']) {
    assert.deepEqual(splitTip(text), { label: text, key: '', details: [] });
  }
});

test('the lines after the first are details', () => {
  assert.deepEqual(splitTip('Cliquer pour nommer (F2)\nC:\Clips\a.mp4'), { label: 'Cliquer pour nommer', key: 'F2', details: ['C:\Clips\a.mp4'] });
});
