import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEdit } from '../src/shared/edit.mjs';
import * as P from '../src/shared/pieces.mjs';

const require = createRequire(import.meta.url);
// The messages checked here are the French ones.
require('../src/main/i18n').setLanguage('fr');
const { ffmpeg, probe } = require('../src/main/ffmpeg');
const { exportClip } = require('../src/main/exporter');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

const noLogs = { refresh: async () => {}, captureFor: () => null };

/** A clip heavy for its length, as OBS records them: noise does not compress. */
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  const videos = path.join(dir, 'Videos');
  fs.mkdirSync(videos);
  const file = path.join(videos, 'clip.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=4,noise=alls=40:allf=t',
    '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
    '-f', 'lavfi', '-i', 'sine=f=1200:r=48000:d=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file,
  ]);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(file, old, old);
  const store = (n) => new Store(path.join(dir, `${n}.json`));
  const meta = store('clips');
  const index = store('index');
  const library = new Library({ settings: { data: { folders: [videos] } }, meta, index, obsLogs: noLogs });
  await library.scan();
  t.after(() => {
    library.stop();
    meta.flush();
    index.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const [clip] = library.clips.values();
  const edit = createEdit(clip, null);
  edit.tracks.forEach((track) => { track.on = true; });
  const send = async (targetMB, montage = edit) => {
    const target = path.join(dir, `discord-${targetMB}.mp4`);
    const log = [];
    await exportClip(clip, { mode: 'discord', targetMB, separate: false, edit: montage }, {
      save: async (out) => fs.promises.copyFile(out, target),
      onLog: (text, live) => log.push({ text, live }),
    });
    return { file: target, size: fs.statSync(target).size, info: await probe(target), log };
  };
  return { clip, edit, send };
}

/** A fingerprint of the picture as stored, to tell a copy from an encode. */
async function pictureHash(file) {
  const chunks = [];
  await ffmpeg(['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], {
    onData: (data) => chunks.push(data),
  });
  return Buffer.concat(chunks).toString().trim();
}

test('for Discord, the picture of the clip is kept intact', async (t) => {
  const { clip, send } = await setup(t);
  const { file, info } = await send(500);
  assert.equal(await pictureHash(file), await pictureHash(clip.path), 'the picture is copied, not encoded');
  assert.equal(info.audio.length, 1, 'every track heard, mixed into one');
});

test('for Discord, a zone keeps the size and rate of the clip', async (t) => {
  const { clip, edit, send } = await setup(t);
  const { info } = await send(500, { ...edit, zone: [1, 3] });
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.ok(Math.abs(info.fps - 30) < 0.5, String(info.fps));
  assert.ok(Math.abs(info.duration - 2) < 0.2, String(info.duration));
  assert.equal(info.audio.length, 1);
});

test('for Discord, a limit the intact clip would pass is kept', async (t) => {
  const { clip, send } = await setup(t);
  assert.ok(clip.size > 3e6, `the clip must be heavy: ${clip.size}`);
  const { size, info } = await send(1);
  assert.ok(size <= 1e6, String(size));
  assert.equal(info.audio.length, 1);
});

/** The lines of the log, without the updates of a running step. */
const stepsOf = (log) => log.filter((line) => !line.live).map((line) => line.text);

test('the log of an export names its steps, and the running one tells how far it is', async (t) => {
  const { send } = await setup(t);
  const { log } = await send(500);
  const steps = stepsOf(log);
  assert.equal(steps[0], 'Montage : 4,0 s, 1 morceau d’image, 2 pistes audio mixées en une');
  assert.equal(steps[1], 'Copie de l’image telle quelle, encodage du son');
  assert.match(steps.at(-1), /^Fichier encodé : \d+(,\d)? Mo$/);
  // An update only ever follows the step it belongs to.
  let step = null;
  for (const line of log) {
    if (!line.live) step = line.text;
    else {
      assert.ok(line.text.startsWith(`${step} : `), line.text);
      assert.match(line.text.slice(step.length), /^ : \d+,\d s \/ 4,0 s(, ×\d+,\d)?$/);
    }
  }
  assert.ok(log.some((line) => line.live), 'ffmpeg reports at least once');
});

test('the log tells why the picture is encoded, and each pass of a size limit', async (t) => {
  const { edit, send } = await setup(t);
  const zoned = stepsOf((await send(500, { ...edit, zone: [1, 3] })).log);
  assert.equal(zoned[1], 'Image réencodée : début coupé');
  assert.match(zoned[2], /^Encodage sur (la carte graphique|le processeur)/);

  const limited = stepsOf((await send(1)).log);
  assert.ok(limited.some((text) => text.endsWith('plus que 1 Mo : taille limitée')
    || text.endsWith('plus que 1 Mo : nouvel essai en taille limitée')), limited.join('\n'));
  assert.ok(limited.some((text) => text.startsWith('Taille limitée à 1 Mo : ')), limited.join('\n'));
  assert.ok(limited.includes('Passe 1 sur 2 : analyse de l’image'));
  assert.ok(limited.includes('Passe 2 sur 2 : encodage'));
});

/** The loudness of the sound of a file between two times, as a root mean square of its samples. */
async function loudness(file, from, to) {
  const chunks = [];
  await ffmpeg(['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', file, '-map', '0:a:0',
    '-ac', '1', '-f', 'f32le', '-'], { onData: (data) => chunks.push(data) });
  const bytes = Buffer.concat(chunks);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / Math.max(1, samples.length));
}

test('the volume of one piece of sound changes that piece only', async (t) => {
  const { edit, send } = await setup(t);
  edit.tracks[1].on = false;
  const cut = P.split(edit.pieces, 2, { only: (x) => x.lane === 0, keepGroup: true });
  const second = P.pieceAt(cut, 0, 3);
  const { file } = await send(500, { ...edit, pieces: P.setVolume(cut, new Set([second.id]), 0.25) });
  const before = await loudness(file, 0.3, 1.7);
  const after = await loudness(file, 2.3, 3.7);
  assert.ok(before > 0.05, `the first piece plays as recorded: ${before}`);
  assert.ok(Math.abs(after / before - 0.25) < 0.03, `the second plays at 25 %: ${after / before}`);
});
