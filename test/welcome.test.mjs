import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Welcome, obsState, covers, FILE } = require('../src/main/welcome');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An OBS profile in simple mode that records into `folder`, written the way OBS writes it. */
function fakeObs(dir, folder) {
  const profile = path.join(dir, 'basic', 'profiles', 'Main');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.ini'), '[Basic]\r\nProfileDir=Main\r\n');
  fs.writeFileSync(path.join(profile, 'basic.ini'),
    `[Output]\r\nMode=Simple\r\n\r\n[SimpleOutput]\r\nFilePath=${folder.replaceAll('\\', '\\\\')}\r\n`);
  return dir;
}

test('the screen shows until its file is written, and again once the file is deleted', (t) => {
  const dir = temp(t);
  const welcome = new Welcome(dir);
  assert.equal(welcome.needed, true);
  welcome.done('Delete this file to see the welcome screen again.');
  assert.equal(welcome.needed, false);
  assert.match(fs.readFileSync(path.join(dir, FILE), 'utf8'), /^Delete this file/);
  assert.equal(new Welcome(dir).needed, false);
  fs.rmSync(path.join(dir, FILE));
  assert.equal(new Welcome(dir).needed, true);
});

test('a clip folder holds its subfolders, whatever the case, and not its neighbours', () => {
  assert.equal(covers(['C:\\Videos'], 'c:\\videos\\Valorant'), true);
  assert.equal(covers(['C:\\Videos\\'], 'C:\\Videos'), true);
  assert.equal(covers(['C:\\Videos'], 'C:\\Videos2'), false);
  assert.equal(covers([], 'C:\\Videos'), false);
});

test('where OBS records, and whether ClipShelf reads there', (t) => {
  const dir = temp(t);
  const clips = path.join(dir, 'Clips');
  fs.mkdirSync(clips);
  const obs = fakeObs(path.join(dir, 'obs-studio'), clips);
  assert.deepEqual(obsState(obs, [clips]), { installed: true, folders: [{ path: clips, exists: true, covered: true }] });
  assert.deepEqual(obsState(obs, [path.join(dir, 'Other')]).folders[0].covered, false);
  fs.rmSync(clips, { recursive: true });
  assert.equal(obsState(obs, []).folders[0].exists, false);
  assert.deepEqual(obsState(path.join(dir, 'none'), []), { installed: false, folders: [] });
});
