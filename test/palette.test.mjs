import test from 'node:test';
import assert from 'node:assert/strict';
import { rankItems } from '../src/shared/palette.mjs';

const items = [
  { label: 'Réglages', weight: 0 },
  { label: 'Place disque', weight: 0 },
  { label: 'Thème : Forêt', weight: 0 },
  { label: 'Valorant', keywords: 'jeu', weight: 1 },
  { label: 'Clove - ACE Revive', keywords: 'Valorant #ace', weight: 2, needsQuery: true },
  { label: 'Chamber ACE', keywords: 'Valorant', weight: 2, needsQuery: true },
];
const labels = (query) => rankItems(items, query).map((item) => item.label);

test('without words: every command, in order, and no clip', () => {
  assert.deepEqual(labels(''), ['Réglages', 'Place disque', 'Thème : Forêt', 'Valorant']);
});

test('every word must match, accents and case aside', () => {
  assert.deepEqual(labels('reglages'), ['Réglages']);
  assert.deepEqual(labels('FORET'), ['Thème : Forêt']);
  // Both have a word that starts with "ace": the order they were given in decides.
  assert.deepEqual(labels('ace valorant'), ['Clove - ACE Revive', 'Chamber ACE']);
});

test('a label that starts with the words comes before one that holds them, then by weight', () => {
  assert.deepEqual(labels('val'), ['Valorant', 'Clove - ACE Revive', 'Chamber ACE']);
  assert.deepEqual(labels('cha'), ['Chamber ACE']);
});

test('the list stops at the limit', () => {
  assert.equal(rankItems(items, '', 2).length, 2);
});
