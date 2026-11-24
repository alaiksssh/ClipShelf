import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/shared/pieces.mjs';
import * as tr from '../src/shared/transitions.mjs';
import { createEdit, loadEdit, canCopyVideo } from '../src/shared/edit.mjs';
import { join } from '../src/shared/restore.mjs';

const clip = { duration: 30, audio: [{}, {}] };
const start = () => createEdit(clip).pieces;
const thirds = () => p.split(p.split(start(), 10), 20);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const dissolve = { kind: 'dissolve', duration: 1 };

test('a transition at a cut is centred on it and taken from the piece after', () => {
  const pieces = tr.setTransition(thirds(), p.VIDEO, 10, dissolve);
  const [only] = tr.transitionsOf(pieces, p.VIDEO);
  near(only.start, 9.5);
  near(only.end, 10.5);
  assert.equal(only.left.to, 10);
  assert.equal(only.right.from, 10);
  assert.deepEqual(only.owner, { id: p.pieceAt(pieces, p.VIDEO, 15).id, side: 'in' });
  assert.equal(tr.transitionsOf(pieces, 0).length, 0, 'the sound has its own');
  assert.equal(p.totalLength(pieces), 30, 'the montage keeps its length');
});

test('at an edge with nothing next to it, a fade starts or ends there', () => {
  let pieces = tr.setTransition(start(), p.VIDEO, 0, { kind: 'black', duration: 2 });
  pieces = tr.setTransition(pieces, p.VIDEO, 30, { kind: 'white', duration: 1 });
  const [fadeIn, fadeOut] = tr.transitionsOf(pieces, p.VIDEO);
  assert.deepEqual([fadeIn.start, fadeIn.end, fadeIn.left, fadeIn.kind], [0, 2, null, 'black']);
  assert.deepEqual([fadeOut.start, fadeOut.end, fadeOut.right, fadeOut.kind], [29, 30, null, 'white']);
});

test('a transition never takes more than half of a piece', () => {
  const pieces = tr.setTransition(p.split(start(), 1), p.VIDEO, 1, { kind: 'dissolve', duration: 3 });
  const [only] = tr.transitionsOf(pieces, p.VIDEO);
  near(only.start, 0.5);
  near(only.end, 1.5);
});

test('sound gets a crossfade whatever kind is asked', () => {
  const pieces = tr.setTransition(thirds(), 1, 20, { kind: 'wipe', duration: 0.5 });
  assert.equal(tr.transitionsOf(pieces, 1)[0].kind, tr.SOUND_KIND);
  const [out, into] = tr.crossfadeGains(0.5);
  near(out * out + into * into, 1);
});

test('cutting a piece keeps each transition on its own side, once', () => {
  let pieces = tr.setTransition(start(), p.VIDEO, 0, dissolve);
  pieces = tr.setTransition(pieces, p.VIDEO, 30, dissolve);
  pieces = p.split(pieces, 12);
  const [left, right] = p.onLane(pieces, p.VIDEO);
  assert.ok(left.transitionIn && !left.transitionOut);
  assert.ok(!right.transitionIn && right.transitionOut);
  assert.equal(tr.transitionsOf(pieces, p.VIDEO).length, 2);
});

test('a cut holding a transition does not close', () => {
  const pieces = tr.setTransition(thirds(), p.VIDEO, 10, dissolve);
  assert.equal(join(pieces, 10, [p.VIDEO]), pieces);
  const removed = tr.setTransition(pieces, p.VIDEO, 10, null);
  assert.equal(tr.transitionsOf(removed, p.VIDEO).length, 0);
  assert.notEqual(join(removed, 10, [p.VIDEO]), removed);
});

test('saved transitions come back checked, and the picture is no longer copied', () => {
  const pieces = tr.setTransition(thirds(), p.VIDEO, 10, { kind: 'zoom', duration: 9 });
  const saved = loadEdit({ version: 2, pieces: pieces.map((x) => (x.lane === 0 ? { ...x, transitionIn: { kind: 'nope', duration: 'x' } } : x)) }, clip);
  const [only] = tr.transitionsOf(saved.pieces, p.VIDEO);
  assert.deepEqual([only.kind, only.right.transitionIn.duration], ['zoom', tr.MAX_DURATION]);
  assert.equal(saved.pieces.filter((x) => x.lane === 0).some((x) => x.transitionIn), false);
  assert.equal(canCopyVideo(createEdit(clip)), true);
  assert.equal(canCopyVideo({ ...createEdit(clip), pieces: tr.setTransition(start(), p.VIDEO, 0, dissolve) }), false);
});

test('random montages with transitions: none overlaps, all stay inside', () => {
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 1500; run += 1) {
    let pieces = start();
    for (let step = 0; step < 12 && pieces.length; step += 1) {
      const total = p.totalLength(pieces);
      const piece = pieces[Math.floor(random() * pieces.length)];
      const lane = Math.floor(random() * 3) - 1;
      const edges = tr.edgesOf(pieces, lane);
      const operations = [
        () => p.split(pieces, random() * total),
        () => p.rippleDelete(pieces, [random() * total, random() * total + 1].sort((a, b) => a - b)),
        () => p.rippleMove(pieces, p.spanOf([piece]), random() * total),
        () => tr.setTransition(pieces, lane, edges[Math.floor(random() * edges.length)], { kind: 'dissolve', duration: random() * 3 }),
        () => p.trim(pieces, piece.id, random() < 0.5 ? 'start' : 'end', (random() - 0.5) * 6, { linked: true, ripple: random() < 0.5, duration: 30 }),
      ];
      pieces = operations[Math.floor(random() * operations.length)]();
      for (const where of [p.VIDEO, 0, 1]) {
        const list = tr.transitionsOf(pieces, where).sort((a, b) => a.start - b.start);
        for (const [i, one] of list.entries()) {
          assert.ok(one.start >= -1e-6 && one.end <= p.totalLength(pieces) + 1e-6, `inside: run ${run}`);
          if (i) assert.ok(one.start >= list[i - 1].end - 1e-6, `overlap: run ${run}, step ${step}`);
        }
      }
    }
  }
});
