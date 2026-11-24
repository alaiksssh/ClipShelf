import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/shared/pieces.mjs';
import { createEdit } from '../src/shared/edit.mjs';
import { planReveal, reveal, seamsOf, soundHoles } from '../src/shared/reveal.mjs';

const clip = { duration: 30, audio: [{}, {}] };
const start = () => createEdit(clip).pieces;
const shape = (pieces) => pieces
  .map((x) => [x.lane, x.at, x.from, x.to].map((v) => Math.round(v * 1000) / 1000))
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const plan = (pieces, piece, edge, options = {}) => planReveal(pieces, piece, edge, { clip, linked: true, ...options });
const first = (pieces, lane = p.VIDEO) => p.onLane(pieces, lane)[0];
const last = (pieces, lane = p.VIDEO) => p.onLane(pieces, lane).at(-1);
const all = (pieces, piece, edge, options) => {
  const found = plan(pieces, piece, edge, options);
  return reveal(pieces, found, found.max).pieces;
};

test('the start of a montage can be pulled left', () => {
  const cut = p.rippleDelete(start(), [0, 12]);
  const found = plan(cut, first(cut), 'start');
  assert.equal(found.max, 12);
  const { pieces, push } = reveal(cut, found, 5);
  assert.equal(push, 5);
  for (const row of shape(pieces)) assert.deepEqual(row.slice(1), [0, 7, 30]);
  assert.deepEqual(shape(reveal(cut, found, 12).pieces), shape(start()));
});

test('the end of a montage can be pulled right', () => {
  const cut = p.rippleDelete(start(), [21, 30]);
  assert.deepEqual(shape(all(cut, last(cut), 'end')), shape(start()));
});

test('both sides of a cut give back the deleted part, and the cut closes', () => {
  const cut = p.rippleDelete(start(), [10, 18]);
  for (const [piece, edge] of [[last(cut), 'start'], [first(cut), 'end']]) {
    const found = plan(cut, piece, edge);
    assert.equal(found.max, 8);
    const half = reveal(cut, found, 3).pieces;
    assert.equal(p.totalLength(half), 25);
    assert.equal(p.onLane(half, p.VIDEO).length, 2);
    const whole = reveal(cut, found, 8).pieces;
    assert.deepEqual(shape(whole), shape(start()));
    assert.equal(new Set(whole.map((x) => x.group)).size, 1);
  }
});

test('pulling never repeats what the montage already plays, unless asked', () => {
  const pieces = p.split(start(), 10);
  assert.equal(plan(pieces, last(pieces), 'start').max, 0);
  assert.equal(plan(pieces, first(pieces), 'end').max, 0);
  assert.equal(plan(pieces, last(pieces), 'start', { beyond: true }).max, 10);
  const cut = p.rippleDelete(start(), [10, 18]);
  assert.equal(plan(cut, last(cut), 'start').max, 8);
});

test('a hole is filled before anything is pushed', () => {
  const cut = p.split(p.split(start(), 10), 20).filter((x) => x.at !== 10);
  for (const [piece, edge] of [[last(cut), 'start'], [first(cut), 'end']]) {
    const found = plan(cut, piece, edge);
    const half = reveal(cut, found, 4);
    assert.equal(half.push, 0);
    assert.equal(p.totalLength(half.pieces), 30);
    assert.deepEqual(shape(reveal(cut, found, 10).pieces), shape(start()));
  }
});

test('one track is pulled into its hole without moving anything', () => {
  const cut = p.clearRange(start(), 0, [10, 14]);
  for (const [piece, edge] of [[last(cut, 0), 'start'], [first(cut, 0), 'end']]) {
    const found = plan(cut, piece, edge);
    assert.equal(found.max, 4);
    const half = reveal(cut, found, 2);
    assert.equal(half.push, 0);
    assert.equal(p.totalLength(half.pieces), 30);
    assert.deepEqual(shape(reveal(cut, found, 4).pieces), shape(start()));
  }
});

test('pulling the sound of a column brings the picture along', () => {
  const cut = p.rippleDelete(start(), [0, 6]);
  assert.deepEqual(shape(all(cut, first(cut, 1), 'start')), shape(start()));
});

test('a track cut on its own still pulls the whole column at its outer edge', () => {
  let cut = p.rippleDelete(start(), [0, 6]);
  cut = p.split(cut, 4, { only: (x) => x.lane === 0, keepGroup: true });
  const whole = all(cut, first(cut, 0), 'start');
  assert.deepEqual(shape(whole).filter((x) => x[0] !== 0), shape(start()).filter((x) => x[0] !== 0));
  assert.deepEqual(shape(whole).filter((x) => x[0] === 0), [[0, 0, 0, 10], [0, 10, 10, 30]]);
});

test('sound saved in another group than its picture follows it', () => {
  const cut = p.rippleDelete(start(), [0, 6]).map((x) => (x.lane === p.VIDEO ? x : { ...x, group: 9 }));
  assert.deepEqual(shape(all(cut, first(cut), 'start')), shape(start()));
});

test('sound deleted at the edge comes back with the picture', () => {
  const cut = p.clearRange(p.rippleDelete(start(), [0, 6]), 0, [0, 2]);
  const whole = all(cut, first(cut), 'start');
  assert.deepEqual(shape(whole).filter((x) => x[0] === 0), [[0, 0, 0, 6], [0, 8, 8, 30]]);
});

test('without the link only the pulled lane gets content, and nothing loses sync', () => {
  const cut = p.rippleDelete(start(), [0, 6]);
  const whole = all(cut, first(cut), 'start', { linked: false });
  assert.deepEqual(shape(whole), [[-1, 0, 0, 30], [0, 6, 6, 30], [1, 6, 6, 30]]);
});

test('speed counts', () => {
  const cut = p.rippleDelete(start(), [0, 12]).map((x) => ({ ...x, speed: 2 }));
  const found = plan(cut, first(cut), 'start');
  assert.equal(found.max, 6);
  for (const row of shape(reveal(cut, found, 6).pieces)) assert.deepEqual(row.slice(1), [0, 0, 30]);
});

test('a cut shows one handle for both of its sides', () => {
  const cut = p.rippleDelete(p.rippleDelete(start(), [25, 30]), [10, 18]);
  const handles = seamsOf(cut, clip).map((s) => [s.at, Boolean(s.end), Boolean(s.start), s.seconds]);
  assert.deepEqual(handles, [[10, true, true, 8], [17, true, false, 5]]);
});

test('deleted sound is shown where it was', () => {
  const cut = p.clearRange(start(), 1, [4, 6]);
  assert.deepEqual(soundHoles(cut, clip, 1).map((x) => [x.lane, x.at, x.from, x.to]), [[1, 4, 4, 6]]);
  assert.deepEqual(soundHoles(cut, clip, 0), []);
});

test('pulling any edge of any montage stays valid and in sync', () => {
  let seed = 13;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const playing = (pieces, lane, time) => {
    const piece = p.pieceAt(pieces, lane, time);
    return piece && p.sourceAt(piece, time);
  };
  for (let run = 0; run < 4000; run += 1) {
    let pieces = start();
    for (let step = 0; step < 7 && pieces.length; step += 1) {
      const t = random() * p.totalLength(pieces);
      const piece = pieces[Math.floor(random() * pieces.length)];
      const options = { linked: random() < 0.5, ripple: random() < 0.5, duration: 30 };
      const operations = [
        () => p.split(pieces, t),
        () => p.rippleDelete(pieces, [t, t + 3]),
        () => p.clearRange(pieces, Math.floor(random() * 3) - 1, [t, t + 2]),
        () => p.trim(pieces, piece.id, random() < 0.5 ? 'start' : 'end', (random() - 0.5) * 9, options),
        () => p.moveFree(pieces, new Set([piece.id]), (random() - 0.5) * 9),
        () => p.setSpeed(pieces, piece.id, p.SPEEDS[Math.floor(random() * 7)], options),
      ];
      pieces = operations[Math.floor(random() * operations.length)]();
    }
    if (!pieces.some((x) => x.lane === p.VIDEO)) continue;

    for (let n = 0; n < 4; n += 1) {
      const piece = pieces[Math.floor(random() * pieces.length)];
      const edge = random() < 0.5 ? 'start' : 'end';
      const found = plan(pieces, piece, edge, { linked: random() < 0.8, beyond: random() < 0.1 });
      if (!found.max) continue;
      const amount = random() < 0.5 ? found.max : random() * found.max;
      const { pieces: next, push, time } = reveal(pieces, found, amount);
      assert.equal(p.hasOverlap(next), false, `overlap: run ${run}.${n}`);
      assert.equal(new Set(next.map((x) => x.id)).size, next.length, `ids: run ${run}.${n}`);
      for (const x of next) assert.ok(x.at > -0.01 && x.from > -0.01 && x.to < 30.01, `bounds: run ${run}.${n}`);

      // What played before still plays, at the same place or pushed as a whole.
      for (const probe of [0.13, 0.37, 0.61, 0.89]) {
        const before = probe * p.totalLength(pieces);
        const pushedFrom = edge === 'start' ? found.time : found.time + amount - push;
        if (Math.abs(before - pushedFrom) < 0.02) continue;
        const after = before >= pushedFrom ? before + push : before;
        for (const lane of [p.VIDEO, 0, 1]) {
          const was = playing(pieces, lane, before);
          if (was === undefined) continue;
          const now = playing(next, lane, after);
          assert.ok(now !== undefined && Math.abs(now - was) < 0.02, `sync: run ${run}.${n} lane ${lane} at ${time}`);
        }
      }
      pieces = next;
    }
  }
});
