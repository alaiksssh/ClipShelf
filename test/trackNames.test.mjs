import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ffmpeg, probe } = require('../src/main/ffmpeg');
const { readTrackNames } = require('../src/main/trackNames');
const { labelOf } = require('../src/main/audio');

test('track names are read from MP4 and MKV, like OBS writes them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipshelf-names-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (const extension of ['mp4', 'mkv']) {
    const file = path.join(dir, `clip.${extension}`);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'color=s=160x90:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
      '-map', '0', '-map', '1', '-map', '1', '-map', '1',
      '-c:v', 'libx264', '-c:a', 'aac',
      '-metadata:s:a:0', 'title=GAME', '-metadata:s:a:2', 'title=Micro été',
      '-y', file,
    ]);
    const { audio } = await probe(file);
    // The track without a name must not shift the following ones. It has no label: the interface names it.
    assert.deepEqual(audio.map((track) => labelOf(track.name)), ['GAME', '', 'Micro été'], extension);
  }
});

test('OBS placeholders are not shown as names', () => {
  const placeholders = ['Track6', 'simple_aac', 'simple_aac_recording0', 'SoundHandler', 'OBS Audio Handler', ''];
  for (const name of placeholders) assert.equal(labelOf(name), '', name);
  assert.equal(labelOf('DISCORD'), 'DISCORD');
});

test('a file that is not MP4 gives no names', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipshelf-names-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'damaged.mp4');
  await fs.writeFile(file, Buffer.from('\u0000\u0000\u0000\u0005moovgarbage'));
  assert.equal((await readTrackNames(file)).size, 0);
});
