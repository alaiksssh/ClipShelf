import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as p from '../src/shared/pieces.mjs';
import { createEdit, loadEdit, canCopyVideo, previewOf } from '../src/shared/edit.mjs';
import { cropRect } from '../src/shared/geometry.mjs';

const require = createRequire(import.meta.url);
const { guessGame, guessDate, validName } = require('../src/main/naming');
const { classify } = require('../src/main/audio');
const { parseRange } = require('../src/main/protocol');

const clip = { duration: 30, audio: [{}, {}] };
const start = () => createEdit(clip).pieces;
const thirds = () => p.split(p.split(start(), 10), 20);
const layout = (pieces, lane = p.VIDEO) => p.onLane(pieces, lane).map((x) => [x.at, x.from, x.to]);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('split keeps each column linked', () => {
  const pieces = thirds();
  assert.equal(pieces.length, 9);
  const first = p.pieceAt(pieces, 1, 12);
  assert.equal(p.withLinked(pieces, new Set([first.id])).size, 3);
});

test('moving a part reorders every lane', () => {
  const pieces = p.rippleMove(thirds(), [20, 30], 0);
  for (const lane of [p.VIDEO, 0, 1]) {
    assert.deepEqual(layout(pieces, lane), [[0, 20, 30], [10, 0, 10], [20, 10, 20]]);
  }
  assert.deepEqual(layout(p.rippleMove(thirds(), [0, 10], 30)), [[0, 10, 20], [10, 20, 30], [20, 0, 10]]);
});

test('deleting closes the hole', () => {
  assert.deepEqual(layout(p.rippleDelete(start(), [10, 20])), [[0, 0, 10], [10, 20, 30]]);
});

test('duplicate pushes what follows', () => {
  const pieces = thirds();
  const { pieces: result, ids } = p.insert(pieces, p.copySpan(pieces, [0, 10]), 10, 10);
  assert.equal(ids.length, 3);
  assert.deepEqual(layout(result, 1), [[0, 0, 10], [10, 0, 10], [20, 10, 20], [30, 20, 30]]);
  assert.equal(new Set(result.map((x) => x.id)).size, result.length);
});

test('free move never overlaps', () => {
  const pieces = thirds();
  const last = p.onLane(pieces, 0)[2];
  assert.deepEqual(layout(p.moveFree(pieces, new Set([last.id]), 5), 0)[2], [25, 20, 30]);
  assert.equal(p.hasOverlap(p.moveFree(pieces, new Set([last.id]), -7)), false);
});

test('ripple trim shortens and extends back', () => {
  const pieces = thirds();
  const middle = p.pieceAt(pieces, p.VIDEO, 15);
  const options = { linked: true, ripple: true, duration: 30 };
  const short = p.trim(pieces, middle.id, 'end', -4, options);
  assert.deepEqual(layout(short, 0), [[0, 0, 10], [10, 10, 16], [16, 20, 30]]);
  assert.deepEqual(layout(p.trim(short, middle.id, 'end', 4, options), 0), layout(pieces, 0));
});

test('free trim stops at the neighbour', () => {
  const pieces = thirds();
  const middle = p.pieceAt(pieces, 0, 15);
  assert.equal(p.trim(pieces, middle.id, 'end', 5, { linked: false, ripple: false, duration: 30 }), pieces);
});

test('speed scales the whole span', () => {
  const pieces = thirds();
  const middle = p.pieceAt(pieces, p.VIDEO, 15);
  const result = p.setSpeed(pieces, middle.id, 2, { linked: true, ripple: true });
  assert.deepEqual(layout(result, 1), [[0, 0, 10], [10, 10, 20], [15, 20, 30]]);
  near(p.totalLength(result), 25);
});

test('a muted zone stays linked to the picture', () => {
  const pieces = p.muteRange(start(), [1], [4, 6]);
  assert.deepEqual(p.onLane(pieces, 1).map((x) => x.muted), [false, true, false]);
  assert.equal(p.withLinked(pieces, new Set([pieces[0].id])).size, pieces.length);
});

test('the volume of a passage changes one track only, still linked', () => {
  const pieces = p.volumeRange(start(), [1], [4, 6], 0.5);
  assert.deepEqual(p.onLane(pieces, 1).map(p.volumeOf), [1, 0.5, 1]);
  assert.deepEqual(p.onLane(pieces, 0).map(p.volumeOf), [1]);
  assert.equal(p.withLinked(pieces, new Set([pieces[0].id])).size, pieces.length);
  assert.equal(p.volumeOf(p.pieceAt(p.volumeRange(pieces, [1], [4, 6], 9), 1, 5)), 2, 'capped at 200 %');
});

test('the volume of one piece leaves its linked pieces and the picture alone', () => {
  const pieces = thirds();
  const sound = p.pieceAt(pieces, 0, 15);
  const picture = p.pieceAt(pieces, p.VIDEO, 15);
  const result = p.setVolume(pieces, new Set([sound.id, picture.id]), 1.5);
  assert.deepEqual(result.map(p.volumeOf), pieces.map((x) => (x.id === sound.id ? 1.5 : 1)));
  assert.equal(p.setVolume(result, new Set([sound.id]), 1.5), result, 'nothing to change gives the same list');
  // Saved, it comes back; an older piece without one plays at 100 %.
  const saved = loadEdit({ version: 2, pieces: result.map(({ volume, ...x }) => (x.id === sound.id ? { ...x, volume } : x)) }, clip);
  assert.deepEqual(saved.pieces.map((x) => x.volume), pieces.map((x) => (x.id === sound.id ? 1.5 : 1)));
});

const cutTrack = (pieces, lane, time) => p.split(pieces, time, { only: (x) => x.lane === lane, keepGroup: true });

test('cutting one track leaves the others whole', () => {
  const pieces = cutTrack(start(), 0, 10);
  assert.deepEqual(layout(pieces, 0), [[0, 0, 10], [10, 10, 30]]);
  for (const lane of [p.VIDEO, 1]) assert.deepEqual(layout(pieces, lane), [[0, 0, 30]]);
});

test('a track cut on its own is picked alone, the picture still carries it', () => {
  const pieces = cutTrack(start(), 0, 10);
  for (const piece of p.onLane(pieces, 0)) assert.equal(p.standsAlone(pieces, piece), true);
  for (const lane of [p.VIDEO, 1]) assert.equal(p.standsAlone(pieces, p.pieceAt(pieces, lane, 5)), false);
  assert.equal(p.withLinked(pieces, new Set([p.pieceAt(pieces, p.VIDEO, 5).id])).size, 4);
  for (const piece of thirds()) assert.equal(p.standsAlone(thirds(), piece), false);
});

test('a later full cut links each part of a track to its own picture', () => {
  const pieces = p.split(cutTrack(start(), 0, 10), 5);
  const right = p.pieceAt(pieces, p.VIDEO, 20);
  assert.equal(p.pieceAt(pieces, 0, 20).group, right.group);
  assert.notEqual(p.pieceAt(pieces, 0, 2).group, right.group);
});

test('clearing one track moves nothing', () => {
  const pieces = p.clearRange(start(), 0, [4, 6]);
  assert.deepEqual(layout(pieces, 0), [[0, 0, 4], [6, 6, 30]]);
  for (const lane of [p.VIDEO, 1]) assert.deepEqual(layout(pieces, lane), [[0, 0, 30]]);
});

test('the picture can be trimmed past a cut of one track', () => {
  const pieces = cutTrack(cutTrack(start(), 0, 2), 0, 28);
  const picture = p.pieceAt(pieces, p.VIDEO, 5);
  for (const ripple of [true, false]) {
    const at = ripple ? 0 : 5;
    const options = { linked: true, ripple, duration: 30 };
    const fromStart = p.trim(pieces, picture.id, 'start', 5, options);
    for (const lane of [p.VIDEO, 0]) assert.deepEqual(layout(fromStart, lane)[0], [at, 5, lane === 0 ? 28 : 30]);
    const fromEnd = p.trim(pieces, picture.id, 'end', -5, options);
    for (const lane of [p.VIDEO, 0]) assert.equal(layout(fromEnd, lane).at(-1)[2], 25);
  }
});

test('a speed change keeps a cut track in sync', () => {
  const pieces = cutTrack(start(), 0, 10);
  const id = p.pieceAt(pieces, p.VIDEO, 5).id;
  const result = p.setSpeed(pieces, id, 2, { linked: true, ripple: false });
  assert.deepEqual(layout(result, 0), [[0, 0, 10], [5, 10, 30]]);
});

test('random operations never overlap nor leave the source', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 3000; run += 1) {
    let pieces = start();
    for (let step = 0; step < 14 && pieces.length; step += 1) {
      const total = p.totalLength(pieces);
      const piece = pieces[Math.floor(random() * pieces.length)];
      const t = random() * total;
      const span = p.spanOf([piece]);
      const options = { linked: random() < 0.5, ripple: random() < 0.5, duration: 30 };
      const delta = (random() - 0.5) * 12;
      const operations = [
        () => p.split(pieces, t),
        () => p.rippleMove(pieces, span, t),
        () => p.rippleDelete(pieces, [t, Math.min(total, t + 2)]),
        () => p.moveFree(pieces, new Set([piece.id]), delta),
        () => p.trim(pieces, piece.id, random() < 0.5 ? 'start' : 'end', delta, options),
        () => p.setSpeed(pieces, piece.id, p.SPEEDS[Math.floor(random() * 7)], options),
        () => p.muteRange(pieces, [0], [t, t + 1]),
        () => p.volumeRange(pieces, [1], [t, t + 1.5], random() * 2),
        () => cutTrack(pieces, 0, t),
        () => p.clearRange(pieces, 1, [t, t + 1]),
        () => p.insert(pieces, p.copySpan(pieces, span), t, span[1] - span[0]).pieces,
      ];
      const index = Math.floor(random() * operations.length);
      pieces = operations[index]();
      assert.equal(p.hasOverlap(pieces), false, `overlap: run ${run}, step ${step}, op ${index}`);
      for (const x of pieces) {
        assert.ok(x.from > -0.01 && x.to < 30.01 && x.at > -0.01, `bounds: run ${run}, step ${step}, op ${index}`);
      }
      assert.equal(new Set(pieces.map((x) => x.id)).size, pieces.length, `ids: run ${run}, op ${index}`);
    }
  }
});

test('version 1 edits are converted', () => {
  const edit = loadEdit({
    segments: [{ a: 0, b: 10, speed: 1 }, { a: 14, b: 30, speed: 2 }],
    tracks: [{ on: true, solo: false, volume: 1.5, mutes: [[8, 16]], name: 'Jeu' }],
  }, clip);
  assert.deepEqual(layout(edit.pieces), [[0, 0, 10], [10, 14, 30]]);
  const muted = p.onLane(edit.pieces, 0).filter((x) => x.muted).map((x) => [x.from, x.to]);
  assert.deepEqual(muted, [[8, 10], [14, 16]]);
  assert.equal(edit.tracks[0].volume, 1.5);
  assert.equal(edit.tracks[0].name, 'Jeu');
});

test('fast export only for an uncut picture', () => {
  const edit = createEdit(clip);
  assert.equal(canCopyVideo(edit), true);
  assert.equal(canCopyVideo({ ...edit, pieces: thirds() }), false);
  assert.equal(canCopyVideo({ ...edit, pieces: p.muteRange(edit.pieces, [0], [2, 4]) }), true);
});

test('crop keeps even sizes inside the frame', () => {
  assert.deepEqual(cropRect(1920, 1080, '9:16', 1), { w: 606, h: 1080, x: 1314, y: 0 });
  assert.equal(cropRect(1920, 1080, 'original'), null);
});

test('game and date from paths', () => {
  const root = 'C:\\Videos';
  const uuid = '3b37c285-db8b-4620-9909-b1081a45fd97';
  assert.equal(guessGame(`${root}\\Discord Clips\\Phantom_Blade_Zero_${uuid}.mp4`, root), 'Phantom Blade Zero');
  assert.equal(guessGame(`${root}\\TankWindowClass_Overwatch\\a.mp4`, root), 'Overwatch');
  assert.equal(guessGame(`${root}\\2026-11-21 18-34-03.mp4`, root), '');
  assert.equal(guessDate('2026-11-21 18-34-03.mp4', 0), new Date(2026, 10, 21, 18, 34, 3).getTime());
});

test('file names are validated', () => {
  for (const name of ['..\\x', 'a:b', 'CON', 'end.', '']) assert.equal(validName(name), false, name);
  assert.equal(validName('ace sur Lotus'), true);
});

test('repeated mixes stay off, separate tracks stay on', () => {
  const on = (dot) => classify(['', ''], dot, 1).map((track) => track.on);
  assert.deepEqual(on([[1e6, 1e6], [1e6, 1e6]]), [true, false]);
  assert.deepEqual(on([[1e6, 10], [10, 4e4]]), [true, true]);
  assert.deepEqual(on([[1.04e6, 4e4], [4e4, 4e4]]), [true, false]);
});

test('HTTP ranges', () => {
  assert.deepEqual(parseRange('bytes=10-', 100), [10, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.equal(parseRange('items=1', 100), null);
});

test('the preview of a card follows the montage', () => {
  const clip = { duration: 10, width: 1920, height: 1080, audio: [{}, {}] };
  assert.equal(previewOf(null, clip), null, 'no edit: the file');
  const untouched = createEdit(clip);
  untouched.tracks[1].on = false;
  assert.equal(previewOf(untouched, clip), null, 'sound changes only: still the file');

  const cut = createEdit(clip);
  cut.pieces = p.rippleDelete(cut.pieces, [2, 4]);
  assert.deepEqual(previewOf(cut, clip).runs, [{ from: 0, to: 2, speed: 1 }, { from: 4, to: 10, speed: 1 }]);

  // Split without a change: one run, no seek at the split.
  const split = createEdit(clip);
  split.pieces = p.split(split.pieces, 5);
  split.zone = [1, 8];
  assert.deepEqual(previewOf(split, clip).runs, [{ from: 1, to: 8, speed: 1 }], 'the zone only, joined');

  const framed = { ...createEdit(clip), ratio: '9:16' };
  const plan = previewOf(framed, clip);
  assert.deepEqual(plan.runs, [{ from: 0, to: 10, speed: 1 }]);
  assert.deepEqual([plan.crop.w, plan.crop.h], [606, 1080]);
});
