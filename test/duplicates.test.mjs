import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../src/main/i18n').setLanguage('fr');
const { ffmpeg, probe, checkDecodes } = require('../src/main/ffmpeg');
const { readPackets, align, holds, trimPlan, videoOf, timeOf } = require('../src/main/packets');
const { Duplicates, candidatePairs, groupsOf } = require('../src/main/duplicates');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

const noLogs = { refresh: async () => {}, captureFor: () => null };
const FPS = 30;
// Named as OBS names replays: by the time they were saved.
const NAMES = { A: 'Replay 2026-07-14 00-00-08', B: 'Replay 2026-07-14 00-00-12', C: 'Replay 2026-07-14 00-00-07', D: 'Replay 2026-07-14 00-00-06' };

/**
 * What the replay buffer of OBS does, without OBS: one recording, then saves of parts of it that
 * start on a key frame, as packets copied and counted again from zero. The second sound track is
 * silent, so all its packets are the same.
 */
async function recording(dir, name, { length = 12, pattern = 'testsrc', format = 'mp4' } = {}) {
  const file = path.join(dir, `${name}.${format === 'matroska' ? 'mkv' : 'mp4'}`);
  await ffmpeg([
    '-f', 'lavfi', '-i', `${pattern}=s=320x180:r=${FPS}:d=${length},noise=alls=10:allf=t`,
    '-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${length}`,
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${length}`,
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', String(FPS), '-bf', '2', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata:s:a:0', 'title=GAME', '-metadata:s:a:1', 'title=MIC',
    '-f', format, '-y', file,
  ]);
  return file;
}

/** A save of [from, to) seconds of `source`, from the key frame at `from`. */
async function save(source, target, from, to, { format = 'mp4' } = {}) {
  const { streams } = await readPackets(source, { low: false });
  const v = videoOf({ streams });
  const counts = streams.map((stream, s) => {
    const times = stream.packets.map((_, i) => timeOf(stream, i));
    if (s === v) {
      const keyAt = (time) => stream.packets.findIndex((packet, i) => packet.key && Math.abs(times[i] - time) < 0.5 / FPS);
      const first = keyAt(from);
      const end = to === null ? stream.packets.length : keyAt(to);
      assert.ok(first >= 0 && end > first, `no key frame at ${from} or ${to}`);
      return [first, end];
    }
    // From the very start, the priming packet of the sound, before zero, too.
    const first = from === 0 ? 0 : times.findIndex((time) => time >= from - 1e-6);
    const end = to === null ? times.length : times.findIndex((time) => time >= to - 1e-6);
    return [first, end < 0 ? times.length : end];
  });
  await ffmpeg([
    '-i', source, '-map', '0', '-c', 'copy',
    ...counts.flatMap(([first, end], s) => ['-bsf:' + s, `noise=drop=lt(n\\,${first})+gte(n\\,${end})`]),
    // A copy loses the names that OBS gives the tracks.
    '-metadata:s:a:0', 'title=GAME', '-metadata:s:a:1', 'title=MIC',
    '-output_ts_offset', String(-from), '-f', format, '-y', target,
  ]);
  return target;
}

const hashes = (stream, from = 0, to = stream.packets.length) => stream.packets.slice(from, to).map((packet) => packet.hash);

async function setup(t, { format = 'mp4' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-dup-'));
  const videos = path.join(dir, 'Videos');
  const work = path.join(dir, 'work');
  fs.mkdirSync(videos);
  fs.mkdirSync(work);
  const extension = format === 'matroska' ? 'mkv' : 'mp4';
  const full = await recording(work, 'full', { format });
  const at = Date.now() - 3600e3;
  const replays = {};
  // A covers 0-8 s, B 4-12 s, C 5-7 s (inside both), each saved when it ends.
  for (const [name, from, to] of [['A', 0, 8], ['B', 4, null], ['C', 5, 7]]) {
    const file = await save(full, path.join(videos, `${NAMES[name]}.${extension}`), from, to, { format });
    const end = new Date(at + (to ?? 12) * 1000);
    fs.utimesSync(file, end, end);
    replays[name] = file;
  }
  // D was filmed at the same time by another recorder: same times, other pictures.
  replays.D = await save(await recording(work, 'other', { length: 6, pattern: 'testsrc2', format }),
    path.join(videos, `${NAMES.D}.${extension}`), 0, null, { format });
  fs.utimesSync(replays.D, new Date(at + 6000), new Date(at + 6000));

  const store = (n) => new Store(path.join(dir, `${n}.json`));
  const settings = { data: { folders: [videos] } };
  const meta = store('clips');
  const index = store('index');
  const library = new Library({ settings, meta, index, obsLogs: noLogs });
  await library.scan();
  const bin = [];
  const trashItem = async (item) => {
    bin.push(path.basename(item));
    fs.rmSync(item);
  };
  const duplicates = new Duplicates({ library, store: store('duplicates'), trashItem });
  t.after(() => {
    duplicates.stop();
    library.stop();
    meta.flush();
    index.flush();
    duplicates.store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const clip = (name) => [...library.clips.values()].find((c) => c.name === NAMES[name]);
  return { dir, videos, full, replays, library, meta, bin, duplicates, clip };
}

test('packets line up saves of the same recording, and nothing else', async (t) => {
  const { replays, full } = await setup(t);
  const read = async (name) => readPackets(replays[name], { low: false });
  const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(read));

  assert.ok(Math.abs(align(a, b).shift - 4) < 0.001, `shift ${align(a, b).shift}`);
  assert.ok(Math.abs(align(b, a).shift + 4) < 0.001);
  assert.ok(Math.abs(align(b, c).shift - 1) < 0.001);
  assert.equal(align(a, d), null);
  assert.ok(holds(a, c) && holds(b, c));
  assert.ok(!holds(a, b) && !holds(c, b));

  // B can start where A stops: 8 s is a key frame, so nothing stays twice.
  const plan = trimPlan(a, b);
  assert.ok(Math.abs(plan.start - 4) < 0.001, `start ${plan.start}`);
  assert.ok(plan.left < 0.001);
  // The silent track, all made of the same packet, is lined up by the picture.
  const whole = await readPackets(full, { low: false });
  assert.equal(b.streams[2].packets.length - plan.drops[2] + a.streams[2].packets.length,
    whole.streams[2].packets.length);
});

test('candidates come from the times of the files, groups from what the packets say', () => {
  const at = 1e12;
  const clip = (id, end, duration, extra = {}) => ({
    id, key: id, path: `${id}.mp4`, mtime: at + end * 1000, duration, size: duration * 1e6,
    codec: 'h264', width: 1920, height: 1080, fps: 60, audio: [{}], ...extra,
  });
  const a = clip('a', 100, 100);
  const b = clip('b', 140, 100);
  const c = clip('c', 300, 100); // Filmed later: never read.
  const e = clip('e', 130, 100, { height: 720 }); // Another setting.
  const long = clip('long', 3000, 3000); // A recording.
  const pairs = candidatePairs([a, b, c, e, long]).map(([x, y]) => `${x.id}${y.id}`);
  assert.deepEqual(pairs, ['ab']);

  const [group] = groupsOf([a, b], [[a, b, 40]]);
  assert.deepEqual(group.ids, ['a', 'b']);
  assert.equal(group.length, 140);
  assert.equal(group.shared, 60);
  assert.equal(group.saved, 60e6); // 60 s of the 100 s of a.
  assert.deepEqual(group.clips.map((member) => member.shared), [60, 60]);

  const inner = clip('i', 90, 30);
  const [nested] = groupsOf([a, b, inner], [[a, b, 40], [b, inner, 10]]);
  assert.deepEqual(nested.clips.map((member) => [member.id, member.start, member.inside]),
    [['a', 0, false], ['b', 40, false], ['i', 50, true]]);
  assert.equal(nested.saved, 60e6 + 30e6);
});

test('the background look finds the group once, and reads nothing the second time', async (t) => {
  const { duplicates, clip } = await setup(t);
  assert.ok(duplicates.summary().pending >= 3);
  let reads = 0;
  const read = duplicates.read;
  duplicates.read = (...args) => {
    reads += 1;
    return read(...args);
  };
  await duplicates.look();
  const { pending, groups } = duplicates.summary();
  assert.equal(pending, 0);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.deepEqual(group.ids, ['A', 'B', 'C'].map((name) => clip(name).id));
  assert.deepEqual(group.clips.map((member) => member.inside), [false, false, true]);
  assert.ok(Math.abs(group.length - 12) < 0.1, `length ${group.length}`);
  assert.ok(reads >= 3);

  reads = 0;
  await duplicates.look();
  assert.equal(reads, 0);
});

test('a look put off by a job is a promise, and the timer tries again once the job is over', async (t) => {
  const { EventEmitter } = require('node:events');
  const library = Object.assign(new EventEmitter(), { meta: { data: {} }, clips: new Map() });
  let busy = true;
  const duplicates = new Duplicates({ library, store: { data: {} }, trashItem: async () => {}, busy: () => busy });
  t.after(() => duplicates.stop());
  // The timer used to call .catch on what look() gave back, which was null during a job.
  assert.ok(duplicates.look() instanceof Promise);
  duplicates.holds = 1;
  assert.ok(duplicates.look() instanceof Promise);
  duplicates.holds = 0;

  let looks = 0;
  const look = duplicates.look.bind(duplicates);
  duplicates.look = () => {
    looks += 1;
    return look();
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  duplicates.schedule(1);
  await pause();
  assert.equal(looks, 0);
  busy = false;
  await pause();
  assert.equal(looks, 1);
});

for (const format of ['mp4', 'matroska']) {
  test(`joining (${format}) gives the recording back, packet for packet, with what each replay had`, async (t) => {
    const { duplicates, clip, library, meta, bin, full, replays, videos } = await setup(t, { format });
    const [a, b, c] = ['A', 'B', 'C'].map(clip);
    meta.data[a.key] = {
      favorite: true,
      tags: ['clutch'],
      moments: { detected: 2, items: [{ id: 1, kind: 'mark', time: 2, name: 'start', color: 'gpu' }, { id: 2, kind: 'kill', time: 6 }], rounds: [] },
      edit: { version: 2, tracks: [{ on: true }, { on: false }] },
    };
    meta.data[b.key] = {
      tags: ['ace'],
      title: 'Ace',
      moments: { detected: 2, items: [{ id: 1, kind: 'kill', time: 2 }, { id: 2, kind: 'kill', time: 6 }], rounds: [] },
    };
    meta.data[c.key] = { moments: { items: [{ id: 1, kind: 'mark', time: 1, name: 'here', color: 'ram' }] } };
    let progress = 0;

    const result = await duplicates.resolve([a.id, b.id, c.id], 'join', { onProgress: (value) => { progress = value; } });
    assert.equal(progress, 1);
    const extension = format === 'matroska' ? 'mkv' : 'mp4';
    assert.deepEqual(fs.readdirSync(videos).sort(), [`${NAMES.D}.${extension}`, `${NAMES.B}.${extension}`]);
    assert.deepEqual(bin.sort(), [`${NAMES.C}.${extension}`, `${NAMES.A} (avant fusion).${extension}`, `${NAMES.B} (avant fusion).${extension}`].sort());
    assert.equal(result.trashed, true);
    assert.deepEqual(result.left, []);
    assert.ok(result.after < result.before);

    // Every packet of the recording, in order, and the streams still together. MKV moves all of
    // them a little, as it moved A: its sound may not start before zero.
    const joined = await readPackets(replays.B, { low: false });
    const whole = await readPackets(full, { low: false });
    const moved = timeOf(joined.streams[0], 0) - timeOf(whole.streams[0], 0);
    assert.ok(Math.abs(moved) < (format === 'mp4' ? 0.001 : 0.03), `moved by ${moved}`);
    for (const [s, stream] of whole.streams.entries()) {
      assert.deepEqual(hashes(joined.streams[s]), hashes(stream), `stream ${s}`);
      const offsets = [0, 100, stream.packets.length - 1].map((i) => timeOf(joined.streams[s], i) - timeOf(stream, i) - moved);
      assert.ok(offsets.every((offset) => Math.abs(offset) < 0.002), `stream ${s}: ${offsets}`);
    }
    await checkDecodes(replays.B, { low: false });
    const info = await probe(replays.B);
    assert.deepEqual(info.audio.map((track) => track.name), ['GAME', 'MIC']);

    const now = library.get(result.id);
    assert.equal(now.path, replays.B);
    assert.ok(Math.abs(now.duration - 12) < 0.1);
    const saved = meta.data[now.key];
    assert.equal(saved.favorite, true);
    assert.equal(saved.title, 'Ace');
    assert.deepEqual(saved.tags.sort(), ['ace', 'clutch']);
    // Marks of A and C, and where A and C were saved. Kills of the time both had, once.
    const marks = saved.moments.items.filter((m) => m.kind === 'mark').map((m) => [Math.round(m.time), m.name]);
    assert.deepEqual(marks, [[2, 'start'], [6, 'here'], [7, ''], [8, '']]);
    const kills = saved.moments.items.filter((m) => m.kind === 'kill').map((m) => Math.round(m.time));
    assert.deepEqual(kills, [6, 10]);
    assert.equal(saved.moments.detected, 2); // Both parts were read: the detector has nothing to read again.
    assert.deepEqual(saved.edit.tracks.map((track) => track.on), [true, false]);
    const video = saved.edit.pieces.filter((piece) => piece.lane === -1);
    assert.equal(video.length, 1, 'one piece: the export can still copy the picture');
    assert.ok(Math.abs(video[0].to - now.duration) < 0.1);
  });
}

test('cutting keeps each replay with its end, starts the next one where the one before stops', async (t) => {
  const { duplicates, clip, library, meta, bin, full, replays } = await setup(t);
  const [a, b, c] = ['A', 'B', 'C'].map(clip);
  const aBefore = fs.readFileSync(replays.A);
  meta.data[b.key] = {
    moments: { detected: 2, items: [{ id: 1, kind: 'mark', time: 1, name: 'early', color: 'gpu' }, { id: 2, kind: 'kill', time: 6 }], rounds: [5] },
    edit: { version: 2, tracks: [{ on: false }, { on: true }], zone: [1, 3] },
  };
  meta.data[c.key] = { favorite: true };

  const result = await duplicates.resolve([a.id, b.id, c.id], 'trim');
  assert.deepEqual(bin.sort(), [`${NAMES.C}.mp4`, `${NAMES.B} (avant découpe).mp4`].sort());
  assert.ok(fs.readFileSync(replays.A).equals(aBefore), 'A stays as it was');
  assert.ok(result.after < result.before);

  // B now starts at 8 s of the recording: the packets after A, not one more or less.
  const cut = await readPackets(replays.B, { low: false });
  const whole = await readPackets(full, { low: false });
  const ended = await readPackets(replays.A, { low: false });
  for (const [s, stream] of whole.streams.entries()) {
    const kept = ended.streams[s].packets.length;
    assert.deepEqual([...hashes(ended.streams[s]), ...hashes(cut.streams[s])], hashes(stream), `stream ${s}`);
    const offset = timeOf(cut.streams[s], 0) - timeOf(stream, kept);
    assert.ok(Math.abs(offset + 8) < 0.002, `stream ${s} moved by ${offset}`);
  }
  await checkDecodes(replays.B, { low: false });

  const now = library.get(library.list().find((item) => item.path === replays.B).id);
  assert.ok(Math.abs(now.duration - 4) < 0.1);
  const own = meta.data[now.key];
  assert.deepEqual(own.moments.items.map((m) => [m.kind, Math.round(m.time)]), [['kill', 2]]);
  assert.deepEqual(own.moments.rounds, [1]);
  assert.deepEqual(own.edit.tracks.map((track) => track.on), [false, true]);
  assert.equal(own.edit.zone, null); // It was in the time that went.
  // The mark of B before the cut, and C with its favourite, are in A now.
  const first = meta.data[a.key];
  assert.equal(first.favorite, true);
  assert.deepEqual(first.moments.items.map((m) => [m.kind, Math.round(m.time), m.name]), [['mark', 5, 'early'], ['mark', 7, '']]);
});

test('a clip that changed or no longer matches is left alone', async (t) => {
  const { duplicates, clip, replays, bin } = await setup(t);
  const [a, d] = ['A', 'D'].map(clip);
  await assert.rejects(duplicates.resolve([a.id, d.id], 'join'), /ne partagent plus/);
  fs.appendFileSync(replays.A, Buffer.alloc(16));
  await assert.rejects(duplicates.resolve([a.id, clip('B').id], 'join'), /changé/);
  assert.deepEqual(bin, []);
});
