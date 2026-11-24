import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseLog, gameInSession, recordingFolders } = require('../src/main/obsLogs');
const { gameFromProcess } = require('../src/main/games');

// Shortened from a real OBS 33 log.
const LOG = [
  "23:58:00.000: [game-capture: 'Capture de jeu'] attempting to hook process: VALORANT-Win64-Shipping.exe",
  "23:58:01.000: [game-capture: 'Capture de jeu'] shared texture capture successful",
  '23:58:01.000: \texecutable: VALORANT-Win64-Shipping.exe',
  '23:58:01.000: \ttitle: VALORANT  ',
  "23:58:30.000: [game-capture: 'Renamed source'] shared texture capture successful",
  "23:59:50.000: [mp4 output: 'simple_file_output'] Writing Hybrid MP4/MOV file 'C:/Videos/rec.mp4'...",
  "00:01:00.000: [ffmpeg muxer: 'Tampon de relecture (Replay Buffer)'] Wrote replay buffer to 'C:/Videos/Replay é.mp4'",
  "00:02:00.000: [game-capture: 'Renamed source'] capture stopped",
  "00:05:00.000: [ffmpeg muxer: 'Tampon de relecture (Replay Buffer)'] Wrote replay buffer to 'C:/Videos/desktop.mp4'",
  "00:06:00.000: [game-capture: 'Renamed source'] attempting to hook process: javaw.exe",
  '00:06:00.000: \texecutable: javaw.exe',
  '00:06:00.000: \ttitle: Minecraft NeoForge* 1.21.1',
  "00:06:01.000: [game-capture: 'Renamed source'] gl memory capture successful",
  "00:08:00.000: [ffmpeg muxer: 'Tampon de relecture (Replay Buffer)'] Wrote replay buffer to 'C:/Videos/craft.mp4'",
].join('\r\n');

const session = parseLog('2026-11-22 23-57-00.txt', LOG);
const game = (file, seconds) => gameInSession(session, file, seconds);

test('recordings and replays get the captured game, across midnight and source renames', () => {
  assert.equal(game('C:\\Videos\\rec.mp4', 30), 'Valorant');
  assert.equal(game('c:\\videos\\replay é.mp4', 90), 'Valorant');
  assert.equal(game('C:\\Videos\\craft.mp4', 100), 'Minecraft');
});

test('no game without a capture, nor for files OBS did not write', () => {
  assert.equal(game('C:\\Videos\\desktop.mp4', 60), '');
  assert.equal(game('C:\\Videos\\other.mp4', 60), '');
});

test('process names', () => {
  assert.equal(gameFromProcess('SnippingTool.exe'), '');
  assert.equal(gameFromProcess('java.exe', 'Minecraft: NeoForge Loading...'), 'Minecraft');
  assert.equal(gameFromProcess('S-Game-Win64-Shipping.exe', 'Phantom Blade Zero  '), 'Phantom Blade Zero');
  assert.equal(gameFromProcess('Some_Game-Win64-Shipping.exe'), 'Some Game');
});

test('clip folders start as the one OBS records into, for the profile in use and its mode', (t) => {
  const obs = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-obs-'));
  t.after(() => fs.rmSync(obs, { recursive: true, force: true }));
  const write = (file, lines) => {
    fs.mkdirSync(path.dirname(path.join(obs, file)), { recursive: true });
    fs.writeFileSync(path.join(obs, file), lines.join('\r\n'));
  };
  // As OBS writes them: advanced mode keeps the path of simple mode, with doubled backslashes.
  write('basic/profiles/Sans_nom/basic.ini', ['[Output]', 'Mode=Advanced', '[SimpleOutput]',
    'FilePath=C:\\Users\\me\\Videos', '[AdvOut]', 'RecFilePath=I:/ClipShelf/Clips']);
  write('basic/profiles/Old/basic.ini', ['[SimpleOutput]', 'FilePath=C:\\Users\\me\\Downloads']);

  assert.deepEqual(recordingFolders(obs).sort(), [path.resolve('C:/Users/me/Downloads'), path.resolve('I:/ClipShelf/Clips')]);
  write('user.ini', ['[Basic]', 'Profile=Sans nom', 'ProfileDir=Sans_nom']);
  assert.deepEqual(recordingFolders(obs), [path.resolve('I:/ClipShelf/Clips')]);
  write('user.ini', ['[Basic]', 'ProfileDir=Old']);
  assert.deepEqual(recordingFolders(obs), [path.resolve('C:/Users/me/Downloads')]); // Simple mode.
  assert.deepEqual(recordingFolders(path.join(obs, 'missing')), []);
});
