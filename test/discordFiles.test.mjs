import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DiscordFiles, GRACE, READ_EVERY } = require('../src/main/discordFiles');

function setup(t, { held = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Each export encodes a file of its own, which place() moves.
  let count = 0;
  const source = () => {
    count += 1;
    const file = path.join(dir, `out${count}.mp4`);
    fs.writeFileSync(file, 'video');
    return file;
  };
  const clock = { now: 1e12 };
  const reads = [];
  const files = new DiscordFiles({
    dir: path.join(dir, 'Discord'),
    now: () => clock.now,
    held: async () => {
      reads.push(clock.now);
      if (held instanceof Error) throw held;
      return typeof held === 'function' ? held() : held;
    },
  });
  return { files, source, clock, reads };
}

test('a Discord file keeps the name of the clip, in a folder of its own', async (t) => {
  const { files, source } = setup(t);
  const first = await files.place(source(), 'Valorant - Replay');
  const second = await files.place(source(), 'Valorant - Replay');
  assert.equal(path.basename(first.path), 'Valorant - Replay.mp4');
  assert.equal(path.basename(second.path), 'Valorant - Replay.mp4');
  assert.notEqual(first.path, second.path);
  assert.equal(path.dirname(path.dirname(first.path)), files.dir);
  assert.equal(first.size, 5);
  assert.ok(!fs.existsSync(path.join(path.dirname(files.dir), 'out1.mp4')), 'moved, not copied');
});

test('a file goes once the clipboard no longer holds it, never in its first minutes', async (t) => {
  let held = [];
  const { files, source, clock } = setup(t, { held: () => held });
  const sent = await files.place(source(), 'clip');
  held = [sent.path];
  files.sent(sent.path, true);

  assert.deepEqual(await files.clear({ force: true }), [], 'too recent');
  clock.now += GRACE + 1;
  assert.deepEqual(await files.clear({ force: true }), [], 'still on the clipboard');
  assert.ok(fs.existsSync(sent.path));

  held = [];
  assert.deepEqual(await files.clear({ force: true }), [path.dirname(sent.path)]);
  assert.equal(fs.existsSync(sent.path), false);
});

test('a new export lets the previous one go, once old enough', async (t) => {
  let held = [];
  const { files, source, clock } = setup(t, { held: () => held });
  const first = await files.place(source(), 'a');
  clock.now += GRACE + 1;
  const second = await files.place(source(), 'b');
  held = [second.path];
  files.sent(second.path, true);
  assert.deepEqual(await files.clear({ force: true }), [path.dirname(first.path)]);
  assert.ok(fs.existsSync(second.path));
});

test('a file the clipboard could not take stays to be dragged, until the next export', async (t) => {
  const { files, source, clock } = setup(t);
  const failed = await files.place(source(), 'a');
  files.sent(failed.path, false);
  clock.now += GRACE + 1;
  assert.deepEqual(await files.clear({ force: true }), []);
  assert.ok(fs.existsSync(failed.path));

  const next = await files.place(source(), 'b');
  files.sent(next.path, true);
  assert.deepEqual(await files.clear({ force: true }), [path.dirname(failed.path)]);
});

test('nothing goes when the clipboard cannot be read', async (t) => {
  const { files, source, clock } = setup(t, { held: new Error('busy') });
  const sent = await files.place(source(), 'a');
  files.sent(sent.path, true);
  clock.now += GRACE + 1;
  const error = console.error;
  console.error = () => {};
  t.after(() => { console.error = error; });
  assert.deepEqual(await files.clear({ force: true }), []);
  assert.ok(fs.existsSync(sent.path));
});

test('the clipboard is read only when something may go, and not on every focus', async (t) => {
  let held = [];
  const { files, source, clock, reads } = setup(t, { held: () => held });
  await files.clear();
  assert.equal(reads.length, 0, 'empty folder');
  const sent = await files.place(source(), 'a');
  held = [sent.path];
  files.sent(sent.path, true);
  await files.clear();
  assert.equal(reads.length, 0, 'too recent to go');

  clock.now += GRACE + 1;
  await files.clear();
  await files.clear();
  assert.equal(reads.length, 1, 'once per while');
  clock.now += READ_EVERY;
  held = [];
  assert.deepEqual(await files.clear(), [path.dirname(sent.path)]);
  assert.equal(reads.length, 2);
});

test('the folder names a path in any case', async (t) => {
  let held = [];
  const { files, source, clock } = setup(t, { held: () => held });
  const sent = await files.place(source(), 'a');
  files.sent(sent.path, true);
  held = [sent.path.toUpperCase()];
  clock.now += GRACE + 1;
  assert.deepEqual(await files.clear({ force: true }), []);
});
