import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/shared/pieces.mjs';
import { createEdit } from '../src/shared/edit.mjs';
import { removedParts, restorePart, restoreAll } from '../src/shared/restore.mjs';

const clip = { duration: 30, audio: [{}, {}] };
const start = () => createEdit(clip).pieces;
const shape = (pieces) => pieces
  .map((x) => [x.lane, x.at, x.from, x.to].map((v) => Math.round(v * 1000) / 1000))
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const parts = (pieces) => removedParts(pieces, clip);
const back = (pieces) => restorePart(pieces, parts(pieces)[0]).pieces;

test('nothing is listed on an untouched clip', () => {
  assert.deepEqual(parts(start()), []);
});

test('a deleted part comes back where it was, without leaving cuts', () => {
  for (const span of [[0, 5], [10, 20], [25, 30]]) {
    const cut = p.rippleDelete(start(), span);
    assert.deepEqual(parts(cut), [{ from: span[0], to: span[1], lanes: [p.VIDEO, 0, 1] }]);
    const whole = back(cut);
    assert.deepEqual(shape(whole), shape(start()));
    assert.equal(new Set(whole.map((x) => x.group)).size, 1);
  }
});

test('a hole left without the magnet is filled without moving anything', () => {
  const cut = p.split(p.split(start(), 10), 20).filter((x) => x.at !== 10);
  assert.deepEqual(shape(back(cut)), shape(start()));
});

test('the part of one track comes back under its picture', () => {
  const cut = p.clearRange(start(), 1, [4, 6]);
  assert.deepEqual(parts(cut), [{ from: 4, to: 6, lanes: [1] }]);
  assert.deepEqual(shape(back(cut)), shape(start()));
});

test('a track part follows a picture that was moved', () => {
  const moved = p.rippleMove(p.split(start(), 10), [0, 10], 30);
  const cut = p.clearRange(moved, 0, [22, 24]);
  assert.deepEqual(parts(cut), [{ from: 2, to: 4, lanes: [0] }]);
  assert.deepEqual(shape(back(cut)), shape(moved));
});

test('a part comes back next to its neighbour in a reordered montage', () => {
  const thirds = p.split(p.split(start(), 10), 20);
  const cut = p.rippleDelete(p.rippleMove(thirds, [20, 30], 0), [20, 30]);
  const video = shape(back(cut)).filter((x) => x[0] === p.VIDEO).map((x) => [x[2], x[3]]);
  assert.deepEqual(video, [[20, 30], [0, 20]]);
});

test('several deletions all come back', () => {
  let cut = p.rippleDelete(start(), [20, 24]);
  cut = p.rippleDelete(cut, [3, 8]);
  cut = p.clearRange(cut, 0, [10, 12]);
  assert.equal(parts(cut).length, 3);
  assert.deepEqual(shape(restoreAll(cut, clip)), shape(start()));
});

test('restoring never overlaps and leaves no picture missing', () => {
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 3000; run += 1) {
    let pieces = start();
    for (let step = 0; step < 8 && pieces.length; step += 1) {
      const total = p.totalLength(pieces);
      const piece = pieces[Math.floor(random() * pieces.length)];
      const t = random() * total;
      const options = { linked: random() < 0.5, ripple: random() < 0.5, duration: 30 };
      const operations = [
        () => p.split(pieces, t),
        () => p.rippleDelete(pieces, [t, Math.min(total, t + 3)]),
        () => p.clearRange(pieces, Math.floor(random() * 3) - 1, [t, t + 2]),
        () => p.trim(pieces, piece.id, random() < 0.5 ? 'start' : 'end', (random() - 0.5) * 12, options),
        () => p.moveFree(pieces, new Set([piece.id]), (random() - 0.5) * 12),
        () => p.setSpeed(pieces, piece.id, p.SPEEDS[Math.floor(random() * 7)], options),
      ];
      pieces = operations[Math.floor(random() * operations.length)]();
    }
    if (!pieces.some((x) => x.lane === p.VIDEO)) continue;
    const whole = restoreAll(pieces, clip);
    assert.equal(p.hasOverlap(whole), false, `overlap: run ${run}`);
    assert.equal(parts(whole).filter((x) => x.lanes.includes(p.VIDEO)).length, 0, `picture missing: run ${run}`);
    assert.equal(new Set(whole.map((x) => x.id)).size, whole.length, `ids: run ${run}`);
    for (const x of whole) assert.ok(x.at > -0.01 && x.from > -0.01 && x.to < 30.01, `bounds: run ${run}`);
  }
});
