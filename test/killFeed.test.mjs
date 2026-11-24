// Synthetic kill feeds, so that the rules hold without needing anyone's videos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KillFeed, Rounds, SCORE, SCORE_BOXES, FRAME_BYTES, WIDTH, FPS, ROW } = require('../src/main/killFeed');

const YELLOW = [229, 233, 118];
const GREEN = [100, 192, 166];
const RED = [238, 90, 86];
const WHITE = [250, 250, 250];
const WALL = [70, 48, 42];
const RIGHT = 673;

function frame(background = WALL) {
  const pixels = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 3) pixels.set(background, i);
  const box = (left, right, top, bottom, color) => {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) pixels.set(color, (y * WIDTH + x) * 3);
    }
  };
  /** An entry. `seed` varies its text, so that two entries differ. */
  const entry = (top, { killer = GREEN, victim = RED, own = null, seed = 1 } = {}) => {
    const left = 230;
    box(left, 510, top, top + ROW, killer);
    box(510, RIGHT, top, top + ROW, victim);
    if (own === 'kill' || own === 'both') box(left, left + 8, top, top + ROW, YELLOW);
    if (own === 'death' || own === 'both') box(RIGHT - 7, RIGHT, top, top + ROW, YELLOW);
    let state = seed;
    for (let x = 280; x < 604; x += 6) {
      if (x >= 470 && x < 530) continue;
      state = (state * 1103515245 + 12345) % 2147483648;
      const height = 4 + ((state >> 8) % 14);
      box(x, x + 3, top + 9, top + 9 + height, WHITE);
    }
  };
  return { pixels, box, entry };
}

/** Plays `draw(second)` for some seconds and returns what was read. */
function play(seconds, draw, background) {
  const feed = new KillFeed();
  for (let i = 0; i < seconds * FPS; i += 1) {
    const picture = frame(background);
    draw(picture, i / FPS);
    feed.push(picture.pixels, i / FPS);
  }
  return feed.result();
}

const kinds = (result) => result.events.map((event) => event.kind);

test('yellow on the left is a kill, at the time it appeared', () => {
  const result = play(9, ({ entry }, t) => t >= 2 && t < 7 && entry(16, { own: 'kill' }));
  assert.deepEqual(kinds(result), ['kill']);
  assert.ok(Math.abs(result.events[0].time - 2) < 0.3);
  assert.equal(result.replay, false);
});

test('yellow on the right is a death', () => {
  const result = play(8, ({ entry }, t) => t >= 1 && t < 6 && entry(16, { killer: RED, victim: GREEN, own: 'death' }));
  assert.deepEqual(kinds(result), ['death']);
});

test('entries of other players do not count', () => {
  const result = play(8, ({ entry }, t) => {
    if (t < 1) return;
    entry(16, { seed: 3 });
    entry(55, { killer: RED, victim: GREEN, seed: 7 });
  });
  assert.deepEqual(kinds(result), []);
});

test('an entry that slides up still counts once', () => {
  const result = play(9, ({ entry }, t) => {
    if (t >= 1 && t < 3) entry(16, { seed: 3 });
    if (t >= 2 && t < 7) entry(t < 3 ? 55 : 16, { own: 'kill', seed: 9 });
  });
  assert.deepEqual(kinds(result), ['kill']);
});

test('two kills shown together are two kills', () => {
  const result = play(8, ({ entry }, t) => {
    if (t >= 1) entry(16, { own: 'kill', seed: 3 });
    if (t >= 2) entry(55, { own: 'kill', seed: 11 });
  });
  assert.deepEqual(kinds(result), ['kill', 'kill']);
});

test('what was already shown on the first picture happened before the clip', () => {
  assert.deepEqual(kinds(play(5, ({ entry }) => entry(16, { own: 'kill' }))), []);
});

test('a resurrection is not a death', () => {
  const result = play(6, ({ entry }, t) => t >= 1 && entry(16, { killer: GREEN, victim: GREEN, own: 'both' }));
  assert.deepEqual(kinds(result), []);
});

test('yellow, red or green scenery is not an entry', () => {
  for (const background of [YELLOW, RED, GREEN, WHITE, WALL]) assert.deepEqual(kinds(play(3, () => {}, background)), []);
  const result = play(5, ({ box }, t) => t >= 1 && box(300, 312, 10, 60, YELLOW));
  assert.deepEqual(kinds(result), []);
});

test('a single glimpse of yellow is not enough', () => {
  const result = play(6, ({ entry }, t) => t >= 1 && entry(16, { own: t === 2 ? 'kill' : null }));
  assert.deepEqual(kinds(result), []);
});

/** A score: each number drawn as its own pattern of white bars. */
function score(picture, left, right) {
  [left, right].forEach((value, side) => {
    const [x0] = SCORE_BOXES[side];
    for (let bar = 0; bar < 6; bar += 1) {
      if (!((value >> bar) & 1)) continue;
      picture.box(x0 + 8 + bar * 7, x0 + 12 + bar * 7, SCORE.at + 7, SCORE.at + 23, WHITE);
    }
  });
}

function roundsOf(seconds, scoreAt) {
  const rounds = new Rounds();
  for (let i = 0; i < seconds * FPS; i += 1) {
    const picture = frame();
    const value = scoreAt(i / FPS);
    if (value) score(picture, ...value);
    rounds.push(picture.pixels, i / FPS);
  }
  return rounds.result();
}

test('a new score starts a new round', () => {
  const starts = roundsOf(80, (t) => (t < 30 ? [3, 5] : t < 60 ? [4, 5] : [4, 6]));
  assert.deepEqual(starts.map(Math.round), [30, 60]);
});

test('a score that blinks or is hidden is no round', () => {
  const starts = roundsOf(40, (t) => (t > 10 && t < 11 ? [9, 9] : t > 20 && t < 25 ? null : [3, 5]));
  assert.deepEqual(starts, []);
});

test('a score that keeps changing has no rounds', () => {
  assert.equal(roundsOf(40, (t) => [Math.floor(t / 4) + 1, 5]), null);
});
