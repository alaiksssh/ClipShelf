import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AGES, byGame, compressible, estimateAfter, olderThan } from '../src/shared/storage.mjs';

const require = createRequire(import.meta.url);
// The messages checked here are the French ones.
require('../src/main/i18n').setLanguage('fr');
const { ffmpeg, probe } = require('../src/main/ffmpeg');
const { Library } = require('../src/main/library');
const { Compressor } = require('../src/main/compressor');
const { Store } = require('../src/main/store');

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const noLogs = { refresh: async () => {}, captureFor: () => null };
const sound = (file) => ffmpeg(['-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).then(String);

const CODECS = { '.avi': ['mpeg4', '-q:v', '1'], h265: ['libx265', '-crf', '20', '-x265-params', 'log-level=error'] };

async function setup(t, name, codec = CODECS[path.extname(name)] || ['libx264', '-crf', '0']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  const videos = path.join(dir, 'Videos');
  fs.mkdirSync(videos);
  const file = path.join(videos, name);
  // Noise, like a game: a recording in lossless H.264 is what has the most to give back.
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=4,noise=alls=12:allf=t',
    '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
    '-f', 'lavfi', '-i', 'sine=f=1200:r=48000:d=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', ...codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:a:0', 'title=GAME', '-metadata:s:a:1', 'title=MIC', '-y', file,
  ]);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(file, old, old);

  const store = (n) => new Store(path.join(dir, `${n}.json`));
  const settings = { data: { folders: [videos] } };
  const meta = store('clips');
  const index = store('index');
  const library = new Library({ settings, meta, index, obsLogs: noLogs });
  await library.scan();

  const bin = [];
  const trashItem = async (item) => {
    bin.push({ name: path.basename(item), hash: hash(item) });
    fs.rmSync(item);
  };
  t.after(() => {
    library.stop();
    meta.flush();
    index.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const [clip] = library.clips.values();
  return { videos, file, library, meta, bin, clip, compressor: new Compressor({ library, trashItem }) };
}

for (const name of ['clip.mp4', 'clip.mkv', 'clip.avi']) {
  test(`compressing ${name} keeps sound, names, length and details, and bins the original`, async (t) => {
    const { videos, file, library, meta, bin, clip, compressor } = await setup(t, name);
    const first = hash(file);
    const before = await sound(file);
    const moments = { detected: 2, items: [{ kind: 'kill', time: 1.5 }] };
    meta.data[clip.key] = { favorite: true, tags: ['ace'], game: 'Valorant', title: 'Mon clip', category: 'Clips', moments };
    let progress = 0;

    const result = await compressor.compress(clip, { onProgress: (value) => { progress = value; } });
    assert.equal(result.skipped, undefined, result.skipped);
    const now = library.get(result.id);
    const target = name.replace('.avi', '.mp4');
    assert.equal(path.basename(now.path), target);
    assert.deepEqual(fs.readdirSync(videos), [target]);
    assert.equal(now.codec, 'hevc');
    assert.ok(now.size < clip.size * 0.85, `${now.size} for ${clip.size}`);
    assert.equal(result.after, now.size);
    assert.ok(Math.abs(now.duration - clip.duration) < 0.1, `duration ${now.duration}`);
    assert.deepEqual(now.audio.map((a) => a.name.toUpperCase()), ['GAME', 'MIC']);
    if (name !== 'clip.avi') assert.equal(await sound(now.path), before, 'the sound is copied, not encoded');
    assert.ok(progress > 0.9);

    const [listed] = library.list();
    assert.deepEqual([listed.favorite, listed.tags, listed.game, listed.title, listed.category],
      [true, ['ace'], 'Valorant', 'Mon clip', 'Clips']);
    assert.deepEqual(listed.moments, moments.items);
    assert.equal(listed.detected, true);
    assert.ok(Math.abs(fs.statSync(now.path).mtimeMs - clip.date) < 1000, 'keeps its date');

    assert.deepEqual(bin, [{ name: `clip (avant compression)${path.extname(name)}`, hash: first }]);
    assert.deepEqual([result.trashed, result.aside], [true, null]);
  });
}

test('a clip already in H.265 is kept as it is', async (t) => {
  const { videos, file, bin, clip, compressor } = await setup(t, 'done.mp4', CODECS.h265);
  const first = hash(file);
  assert.equal(compressible(clip), false);
  assert.deepEqual(await compressor.compress(clip), { skipped: 'déjà compressé' });
  assert.equal(hash(file), first);
  assert.deepEqual(fs.readdirSync(videos), ['done.mp4']);
  assert.equal(bin.length, 0);
});

test('a cancelled compression changes nothing', async (t) => {
  const { videos, file, meta, bin, clip, compressor } = await setup(t, 'cancel.mp4');
  const first = hash(file);
  const keys = Object.keys(meta.data);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(compressor.compress(clip, { signal: abort.signal }));
  assert.equal(hash(file), first);
  assert.deepEqual(fs.readdirSync(videos), ['cancel.mp4']);
  assert.deepEqual(Object.keys(meta.data), keys);
  assert.equal(bin.length, 0);
});

test('a clip that changed meanwhile is not replaced', async (t) => {
  const { file, bin, clip, compressor } = await setup(t, 'changed.mp4');
  fs.appendFileSync(file, Buffer.alloc(16));
  await assert.rejects(compressor.compress(clip), /a changé/);
  assert.equal(bin.length, 0);
});

test('storage: what can be compressed, by game and by age', () => {
  const day = 864e5;
  const now = Date.now();
  const clip = (game, size, codec = 'h264', days = 0) => ({ game, size, codec, date: now - days * day });
  assert.equal(compressible(clip('A', 10)), true);
  assert.equal(compressible(clip('A', 10, 'hevc')), false);
  assert.equal(compressible(clip('A', 10, 'av1')), false);
  assert.equal(compressible({ ...clip('A', 10), busy: true }), false);
  assert.equal(compressible({ ...clip('A', 10), codec: undefined }), false);
  assert.equal(estimateAfter(clip('A', 100)), 50);

  const month = AGES.find((age) => age.id === 'month').days;
  assert.equal(olderThan(clip('A', 1, 'h264', 40), month, now), true);
  assert.equal(olderThan(clip('A', 1, 'h264', 3), month, now), false);
  assert.equal(olderThan(clip('A', 1, 'h264', 3), 0, now), true);

  const clips = ['A', 'B', 'C', 'D'].flatMap((game, i) => [clip(game, 10 * (i + 1)), clip(game, 1)]);
  assert.deepEqual(byGame(clips).map((row) => [row.game, row.size, row.count]),
    [['D', 41, 2], ['C', 31, 2], ['B', 21, 2], ['A', 11, 2]]);
  assert.deepEqual(byGame(clips, 3).map((row) => [row.game, row.size, row.count]),
    [['D', 41, 2], ['C', 31, 2], [null, 32, 4]]);
  assert.equal(byGame(clips, 3)[2].games, 2);
});
