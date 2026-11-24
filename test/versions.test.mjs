import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as P from '../src/shared/pieces.mjs';
import { createEdit } from '../src/shared/edit.mjs';

const require = createRequire(import.meta.url);
// The messages checked here are the French ones.
require('../src/main/i18n').setLanguage('fr');
const { ffmpeg, probe, checkDecodes, Damaged } = require('../src/main/ffmpeg');
const { Library } = require('../src/main/library');
const { Versions, BACKUP_DIR } = require('../src/main/versions');
const { Store } = require('../src/main/store');

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const noLogs = { refresh: async () => {}, captureFor: () => null };

async function setup(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  const videos = path.join(dir, 'Videos');
  fs.mkdirSync(videos);
  const file = path.join(videos, name);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
    '-f', 'lavfi', '-i', 'sine=f=1200:r=48000:d=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', path.extname(name) === '.avi' ? 'mpeg4' : 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:a:0', 'title=GAME', '-metadata:s:a:1', 'title=MIC', '-y', file,
  ]);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(file, old, old);

  const store = (n) => new Store(path.join(dir, `${n}.json`));
  const settings = { data: { folders: [videos] } };
  const meta = store('clips');
  const index = store('index');
  const library = new Library({ settings, meta, index, obsLogs: noLogs });
  assert.ok(library instanceof EventEmitter);
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
  return { videos, file, library, meta, bin, clip, versions: new Versions({ library, trashItem }) };
}

function montage(clip, change = (pieces) => P.rippleDelete(pieces, [1, 2])) {
  const edit = createEdit(clip, null);
  edit.tracks.forEach((track) => { track.on = true; });
  edit.pieces = change(edit.pieces);
  return edit;
}

const save = (versions, clip, edit, extra = {}) =>
  versions.overwrite(clip, { edit, separate: true, labels: ['GAME', 'MIC'] }, { onProgress() {}, ...extra });

for (const name of ['clip.mp4', 'clip.mkv', 'clip.avi']) {
  test(`overwriting ${name} replaces it and keeps nothing else`, async (t) => {
    const { videos, library, meta, bin, clip, versions } = await setup(t, name);
    const edit = montage(clip);
    meta.data[clip.key] = { favorite: true, tags: ['ace'], game: 'Valorant', title: 'Mon clip', edit };

    const saved = await save(versions, clip, edit);
    const now = library.get(saved.id);
    assert.equal(path.basename(now.path), name.replace('.avi', '.mp4'));
    assert.deepEqual(fs.readdirSync(videos), [path.basename(now.path)]);
    assert.ok(Math.abs(now.duration - 3) < 0.2, `duration ${now.duration}`);
    assert.equal(now.audio.length, 2);
    if (name !== 'clip.avi') assert.deepEqual(now.audio.map((a) => a.name.toUpperCase()), ['GAME', 'MIC']);

    const [listed] = library.list();
    assert.equal(listed.edit, null);
    assert.equal(listed.hasPrevious, false);
    assert.deepEqual([listed.favorite, listed.tags, listed.game, listed.title], [true, ['ace'], 'Valorant', 'Mon clip']);
    assert.equal(meta.data[now.key].original, undefined);
    assert.deepEqual(versions.chainOf(now.key), []);
    assert.equal(bin.length, 0);
  });
}

/** What 1.2 to 1.4.0 left behind: the original in .clipshelf-originals, and a link to it. */
async function keptByOlderRelease({ videos, file, library, meta, clip, versions }) {
  const first = hash(file);
  const backup = path.join(videos, BACKUP_DIR, `${clip.key}${path.extname(file)}`);
  fs.mkdirSync(path.dirname(backup));
  fs.copyFileSync(file, backup);
  const now = library.get((await save(versions, clip, montage(clip))).id);
  meta.data[now.key] = { ...meta.data[now.key], original: { key: clip.key, file: backup, extension: path.extname(file) } };
  return { first, backup, now };
}

test('a version kept by an older release still goes back, byte for byte', async (t) => {
  const context = await setup(t, 'legacy.mp4');
  const { file, library, meta, bin, clip, versions } = context;
  const edit = montage(clip);
  meta.data[clip.key] = { edit, favorite: true };
  const { first, now } = await keptByOlderRelease(context);
  assert.equal(library.list()[0].hasPrevious, true);

  const back = library.get((await versions.revert(now)).id);
  assert.equal(back.path, file);
  assert.equal(hash(file), first);
  assert.deepEqual(library.list()[0].edit, edit);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['legacy.mp4']);
  assert.equal(bin.length, 1);
});

test('overwriting again bins what an older release kept', async (t) => {
  const context = await setup(t, 'again.mp4');
  const { videos, library, bin, versions } = context;
  const { first, now } = await keptByOlderRelease(context);
  const saved = library.get((await save(versions, now, montage(now))).id);
  assert.deepEqual(bin.map((item) => item.hash), [first]);
  assert.deepEqual(fs.readdirSync(videos), [path.basename(saved.path)]);
  assert.equal(library.list()[0].hasPrevious, false);
});

test('sound-only changes copy the picture', async (t) => {
  const { file, library, clip, versions } = await setup(t, 'copy.mp4');
  const picture = () => ffmpeg(['-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).then(String);
  const before = await picture();
  const saved = await save(versions, clip, montage(clip, (pieces) => P.clearRange(pieces, 0, [1, 2])));
  assert.equal(await picture(), before);
  assert.equal((await probe(library.get(saved.id).path)).audio.length, 2);
});

test('a cancelled save changes nothing', async (t) => {
  const { videos, file, clip, versions } = await setup(t, 'cancel.mp4');
  const first = hash(file);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(save(versions, clip, montage(clip), { signal: abort.signal }));
  assert.equal(hash(file), first);
  assert.deepEqual(fs.readdirSync(videos), ['cancel.mp4']);
});

test('a file that changed meanwhile is not replaced', async (t) => {
  const { videos, file, clip, versions } = await setup(t, 'changed.mp4');
  const first = hash(file);
  const replace = versions.replace.bind(versions);
  versions.replace = (...args) => {
    const now = new Date();
    fs.utimesSync(file, now, now);
    return replace(...args);
  };
  await assert.rejects(save(versions, clip, montage(clip)), /a changé/);
  assert.equal(hash(file), first);
  const backups = path.join(videos, BACKUP_DIR);
  assert.ok(!fs.existsSync(backups) || !fs.readdirSync(backups).length);
});

test('an existing file with the new name is never replaced', async (t) => {
  const { videos, file, clip, versions } = await setup(t, 'taken.avi');
  const other = path.join(videos, 'taken.mp4');
  fs.writeFileSync(other, 'someone else');
  const first = hash(file);
  await assert.rejects(save(versions, clip, montage(clip)), /porte déjà/);
  assert.equal(hash(file), first);
  assert.equal(fs.readFileSync(other, 'utf8'), 'someone else');
});

test('kept versions are only unused once no clip can go back to them', async (t) => {
  const context = await setup(t, 'trash.mp4');
  const { library, versions } = context;
  const { now } = await keptByOlderRelease(context);
  assert.deepEqual(versions.unused(now.key), []);
  library.forget(now.id);
  assert.equal(versions.unused(now.key).length, 1);
});

test('only the zone is saved over the clip', async (t) => {
  const { library, clip, versions } = await setup(t, 'zone.mp4');
  const edit = { ...montage(clip, (pieces) => pieces), zone: [1, 3] };
  const saved = library.get((await save(versions, clip, edit)).id);
  assert.ok(Math.abs(saved.duration - 2) < 0.15, `duration ${saved.duration}`);
});

/** Changes a run of bytes in the middle of a file, as bits flipped in memory would. */
function damage(file) {
  const { atime, mtime } = fs.statSync(file);
  const bytes = fs.readFileSync(file);
  const at = Math.floor(bytes.length * 0.6);
  for (let i = 0; i < 2048; i += 1) bytes[at + i] ^= 0x5a;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, atime, mtime); // Same date, so the library still takes it for the clip it knows.
}

test('a whole decode tells a sound file from a damaged one', async (t) => {
  const { videos, file } = await setup(t, 'decode.mp4');
  const seen = [];
  await checkDecodes(file, { duration: 4, onProgress: (value) => seen.push(value) });
  assert.equal(seen.at(-1), 1);

  const copy = path.join(path.dirname(videos), 'damaged.mp4');
  fs.copyFileSync(file, copy);
  damage(copy);
  await assert.rejects(checkDecodes(copy), Damaged);
});

test('a clip that does not read back whole is not replaced', async (t) => {
  const { videos, file, clip, versions } = await setup(t, 'unreadable.mp4');
  damage(file);
  const first = hash(file);
  await assert.rejects(save(versions, clip, montage(clip)), /original/);
  assert.equal(hash(file), first);
  assert.deepEqual(fs.readdirSync(videos), ['unreadable.mp4']);
});

test('a damaged result never replaces the clip', async (t) => {
  const { videos, file, meta, clip, versions } = await setup(t, 'result.mp4');
  const first = hash(file);
  const keys = Object.keys(meta.data);
  const out = path.join(path.dirname(videos), 'out.mp4');
  await ffmpeg(['-i', file, '-map', '0', '-c:v', 'libx264', '-crf', '30', '-c:a', 'copy', '-y', out]);
  damage(out);

  const options = { length: clip.duration, groups: [[{}], [{}]], pieces: [] };
  await assert.rejects(versions.replace(clip, { out, options, target: clip.path }), /abîmé/);
  assert.equal(hash(file), first);
  assert.deepEqual(fs.readdirSync(videos), ['result.mp4']);
  assert.deepEqual(Object.keys(meta.data), keys);
});
