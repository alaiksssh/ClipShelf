import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEdit } from '../src/shared/edit.mjs';
import * as P from '../src/shared/pieces.mjs';
import { setTransition } from '../src/shared/transitions.mjs';

const require = createRequire(import.meta.url);
require('../src/main/i18n').setLanguage('fr');
const { ffmpeg, probe } = require('../src/main/ffmpeg');
const { exportClip } = require('../src/main/exporter');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

const noLogs = { refresh: async () => {}, captureFor: () => null };

/** 4 s: red then blue, a tone for the first 2 s and silence after. */
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  const videos = path.join(dir, 'Videos');
  fs.mkdirSync(videos);
  const file = path.join(videos, 'clip.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2,apad=whole_dur=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file,
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
  const render = async (pieces) => {
    const target = path.join(dir, `out-${Date.now()}.mp4`);
    await exportClip(clip, { mode: 'quality', separate: false, edit: { ...edit, pieces } }, {
      save: async (out) => fs.promises.copyFile(out, target),
    });
    return target;
  };
  return { edit, render };
}

/** The colour at the middle of the frame shown at `time`, as [r, g, b]. */
async function colourAt(file, time) {
  const chunks = [];
  await ffmpeg(['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'crop=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { onData: (data) => chunks.push(data) });
  const bytes = Buffer.concat(chunks);
  return [0, 1, 2].map((c) => bytes[c]);
}

async function loudness(file, from, to) {
  const chunks = [];
  await ffmpeg(['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', file, '-map', '0:a:0',
    '-ac', '1', '-f', 'f32le', '-'], { onData: (data) => chunks.push(data) });
  const bytes = Buffer.concat(chunks);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / Math.max(1, samples.length));
}

/** Red 0–1 s of the file, then blue 3–4 s: a cut at 1 s of the montage. */
const redThenBlue = (edit) => P.rippleDelete(edit.pieces, [1, 3]);

test('a dissolve blends both sides of a cut, the montage keeps its length', async (t) => {
  const { edit, render } = await setup(t);
  const file = await render(setTransition(redThenBlue(edit), P.VIDEO, 1, { kind: 'dissolve', duration: 0.6 }));
  const info = await probe(file);
  assert.ok(Math.abs(info.duration - 2) < 0.1, `length ${info.duration}`);
  const [before, middle, after] = await Promise.all([colourAt(file, 0.4), colourAt(file, 1.0), colourAt(file, 1.6)]);
  assert.ok(before[0] > 200 && before[2] < 60, `red before: ${before}`);
  assert.ok(after[2] > 200 && after[0] < 60, `blue after: ${after}`);
  assert.ok(middle[0] > 70 && middle[0] < 190 && middle[2] > 70 && middle[2] < 190, `both in the middle: ${middle}`);
});

test('a fade from black at the start, and the sound crossfades over the cut', async (t) => {
  const { edit, render } = await setup(t);
  let pieces = setTransition(redThenBlue(edit), P.VIDEO, 0, { kind: 'black', duration: 0.5 });
  pieces = setTransition(pieces, 0, 1, { kind: 'crossfade', duration: 0.5 });
  const file = await render(pieces);
  const first = await colourAt(file, 0.03);
  assert.ok(first[0] < 60, `dark at first: ${first}`);
  assert.ok((await colourAt(file, 0.7))[0] > 200, 'red once faded in');
  // Without the crossfade the tone stops at the cut; with it, it fades out over the next quarter second.
  const steady = await loudness(file, 0.3, 0.6);
  const fading = await loudness(file, 1.05, 1.2);
  assert.ok(fading > 0.03 * steady && fading < 0.9 * steady, `fading after the cut: ${fading} of ${steady}`);
  assert.ok(await loudness(file, 1.4, 1.9) < 0.01, 'silent once the crossfade is over');
});

test('a cut where the file has no frame left holds the first frame', async (t) => {
  const { edit, render } = await setup(t);
  // The piece after the cut starts at 0 s of the file: its half of the transition holds that frame.
  const moved = P.rippleMove(P.split(edit.pieces, 1), [0, 1], 4);
  const file = await render(setTransition(moved, P.VIDEO, 3, { kind: 'wipe', duration: 0.5 }));
  const info = await probe(file);
  assert.ok(Math.abs(info.duration - 4) < 0.1, `length ${info.duration}`);
});
