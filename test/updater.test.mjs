import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { updatesEnabled, updaterFolder, updateInstalling } = require('../src/main/updater');

test('updates are looked for by an installed app only, never during a check', () => {
  assert.equal(updatesEnabled({ packaged: true, env: {} }), true);
  assert.equal(updatesEnabled({ packaged: false, env: {} }), false, 'run from the sources');
  assert.equal(updatesEnabled({ packaged: true, env: { CLIPSHELF_DATA: 'C:\temp\check' } }), false, 'a check with its own data');
  assert.equal(updatesEnabled({ packaged: true, env: { CLIPSHELF_UPDATES: 'off' } }), false);
});

test('the folder of downloaded updates is the one named in app-update.yml', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-updater-'));
  try {
    assert.equal(path.basename(updaterFolder(resources)), 'clipshelf-updater', 'without the file');
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\r\nupdaterCacheDirName: other-updater\r\n');
    assert.equal(path.basename(updaterFolder(resources)), 'other-updater');
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('an update counts as installing only while its installer runs', { skip: process.platform !== 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-updater-'));
  const pending = path.join(folder, 'pending');
  try {
    assert.equal(updateInstalling(folder), false, 'nothing downloaded');
    fs.mkdirSync(pending);
    // A small program of Windows stands for the installer: it runs for a few seconds.
    const installer = path.join(pending, 'ClipShelf-Setup-9.9.9.exe');
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'PING.EXE'), installer);
    fs.copyFileSync(installer, path.join(pending, 'temp-ClipShelf-Setup-9.9.9.exe'));
    assert.equal(updateInstalling(folder), false, 'downloaded, not running');
    const run = spawn(installer, ['-n', '4', '127.0.0.1'], { stdio: 'ignore' });
    const ended = new Promise((resolve) => run.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(updateInstalling(folder), true, 'running');
    await ended;
    assert.equal(updateInstalling(folder), false, 'ended');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
