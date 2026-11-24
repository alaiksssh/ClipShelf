import test from 'node:test';
import assert from 'node:assert/strict';
import { joinDetails, joinMoments, joinEdit, marksInto, joinThumb } from '../src/shared/joins.mjs';
import { createEdit } from '../src/shared/edit.mjs';
import { VIDEO } from '../src/shared/pieces.mjs';

const clip = (duration) => ({ duration, audio: [{}, {}] });
const round = (value) => Math.round(value * 100) / 100;
const pictures = (edit) => edit.pieces.filter((piece) => piece.lane === VIDEO).sort((a, b) => a.at - b.at)
  .map((piece) => [round(piece.at), round(piece.from), round(piece.to)]);

test('details: favourite if any, the first name, every tag', () => {
  const details = joinDetails([{ tags: ['a'], title: '' }, { favorite: true, title: 'Ace', tags: ['a', 'b'], category: 'Best' }, undefined]);
  assert.deepEqual(details, { favorite: true, hideTallies: false, tags: ['a', 'b'], title: 'Ace', category: 'Best' });
});

test('two replays without a montage give none', () => {
  const parts = [{ meta: {}, clip: clip(100), from: 0, to: 100, shift: 0 }, { meta: {}, clip: clip(100), from: 60, to: Infinity, shift: 40 }];
  assert.equal(joinEdit(parts, clip(140)), null);
});

test('a montage with cuts keeps its cuts; the part without one comes whole, joined to it', () => {
  // The first replay keeps 10-30 and 50-100 of its file; the second one has no montage.
  const first = createEdit(clip(100));
  first.pieces = [
    ...first.pieces.map((piece) => ({ ...piece, from: 10, to: 30 })),
    ...first.pieces.map((piece) => ({ ...piece, id: piece.id + 10, group: 2, at: 20, from: 50, to: 100 })),
  ];
  first.zone = [25, 60];
  const parts = [
    { meta: { edit: first }, clip: clip(100), from: 0, to: 100, shift: 0 },
    { meta: {}, clip: clip(100), from: 60, to: Infinity, shift: 40 },
  ];
  const joined = joinEdit(parts, clip(140));
  // 10-30, then 50-100 followed in the file by 100-140: one piece.
  assert.deepEqual(pictures(joined), [[0, 10, 30], [20, 50, 140]]);
  assert.deepEqual(joined.zone, [25, 60]);
  assert.equal(joined.pieces.filter((piece) => piece.lane === 0).length, 2, 'sound follows the pictures');
});

test('a part loses what lies outside its times, and the montage closes the gap', () => {
  const second = createEdit(clip(100));
  second.pieces = [
    ...second.pieces.map((piece) => ({ ...piece, from: 0, to: 40 })),
    ...second.pieces.map((piece) => ({ ...piece, id: piece.id + 10, group: 2, at: 40, from: 70, to: 90 })),
  ];
  second.zone = [10, 50];
  // Cut where the second one now starts: at 30 of its file.
  const joined = joinEdit([{ meta: { edit: second }, clip: clip(100), from: 30, to: Infinity, shift: -30 }], clip(70));
  assert.deepEqual(pictures(joined), [[0, 0, 10], [10, 40, 60]]);
  // 10-50 of the montage was 10-40 of the file and 70-80: what is left of it.
  assert.deepEqual(joined.zone.map(round), [0, 20]);
});

test('moments: kills from the times of each part, marks wherever they land, saves as marks', () => {
  const parts = [
    { meta: { moments: { detected: 2, items: [{ kind: 'kill', time: 80 }, { kind: 'mark', time: 90, name: 'clutch', color: 'gpu' }], rounds: [20, 70] } }, clip: clip(100), from: 0, to: 100, shift: 0 },
    { meta: { moments: { detected: 2, items: [{ kind: 'kill', time: 40 }, { kind: 'kill', time: 80 }, { kind: 'mark', time: 50, name: 'clutch', color: 'ram' }], rounds: [30, 75] } }, clip: clip(100), from: 60, to: Infinity, shift: 40 },
  ];
  const moments = joinMoments(parts, { length: 140, saves: [{ time: 100, name: '' }] });
  assert.equal(moments.detected, 2);
  // The kill at 40 of the second one is the kill at 80 of the first.
  assert.deepEqual(moments.items.filter((m) => m.kind === 'kill').map((m) => m.time), [80, 120]);
  // The same mark put in both files is kept once.
  assert.deepEqual(moments.items.filter((m) => m.kind === 'mark').map((m) => [m.time, m.name]), [[90, 'clutch'], [100, '']]);
  assert.deepEqual(moments.rounds, [20, 70, 115]);
  assert.deepEqual(moments.items.map((m) => m.id), [1, 2, 3, 4]);

  assert.equal(joinMoments([{ meta: {}, clip: clip(10), from: 0, to: 10, shift: 0 }]), undefined);
  const unread = joinMoments([parts[0], { ...parts[1], meta: {} }], { length: 140 });
  assert.equal(unread.detected, 0, 'a part never read: the detector reads the new file');
  assert.equal(unread.rounds, null);
});

test('marks of a clip that goes away land in the one that holds it', () => {
  const moments = marksInto({ detected: 2, items: [{ id: 1, kind: 'kill', time: 5 }] }, [{ time: 8, name: 'here' }, { time: 200 }], { length: 60 });
  assert.equal(moments.detected, 2);
  assert.deepEqual(moments.items.map((m) => [m.kind, m.time, m.name]), [['kill', 5, undefined], ['mark', 8, 'here']]);
  assert.ok(moments.items[1].color);
});

test('the chosen picture lands where its part goes, and the last part that keeps one wins', () => {
  const parts = [
    { meta: { thumb: 30 }, from: 0, to: 60, shift: 0 },
    { meta: { thumb: 10 }, from: 20, to: Infinity, shift: 40 },
  ];
  // The second one chose a time that the first one brings: its choice does not come.
  assert.equal(joinThumb(parts), 30);
  assert.equal(joinThumb([parts[0], { ...parts[1], meta: { thumb: 45 } }]), 85);
  assert.equal(joinThumb([{ meta: {}, shift: 0 }, { meta: { thumb: 'x' } }]), undefined);
  // A replay held whole by another one: its time on the clock of the other.
  assert.equal(joinThumb([{ meta: { thumb: 5 }, shift: 12 }, { meta: {} }]), 17);
  assert.equal(joinThumb([{ meta: { thumb: 5 }, shift: 12 }, { meta: { thumb: 2 } }]), 2);
});
