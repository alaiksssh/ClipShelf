import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { updatesEnabled, updaterFolder, updateInstalling, startBlocked } = require('../src/main/updater');

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

const { Updater, downloadShare } = require('../src/main/updater');

test('the share of a download goes to the page in whole percents', () => {
  assert.equal(downloadShare(42.7), 0.42);
  assert.equal(downloadShare(100), 1);
  assert.equal(downloadShare(-3), 0);
  assert.equal(downloadShare(undefined), 0);
});

/** An Updater wired to a stand-in for electron-updater, whose events the test sends. */
function fakeUpdater({ busy = false } = {}) {
  const { EventEmitter } = require('node:events');
  const events = new EventEmitter();
  const told = { changes: 0, shares: [], installs: [] };
  const updater = new Updater({
    app: { isPackaged: true },
    onChange: () => { told.changes += 1; },
    onProgress: (share) => told.shares.push(share),
    busy: () => busy,
  });
  updater.updater = {
    quitAndInstall: (silent, run) => told.installs.push({ silent, run }),
    checkForUpdates: () => Promise.resolve(),
  };
  // The handlers of start(), without its timers and without loading electron-updater.
  for (const name of ['update-available', 'download-progress', 'update-downloaded', 'error']) {
    events.on(name, (...args) => updater.handlers[name](...args));
  }
  return { updater, events, told };
}

test('an update is shown from the moment it is found, with the share of its download', () => {
  const { updater, events, told } = fakeUpdater();
  assert.equal(updater.status(), null);
  events.emit('update-available', { version: '9.9.9', releaseNotes: '<ul><li>A</li></ul>' });
  assert.deepEqual(updater.status(), { version: '9.9.9', ready: false, share: 0, waiting: false, failed: false });
  assert.equal(updater.notes, '<ul><li>A</li></ul>');
  events.emit('download-progress', { percent: 10.2 });
  events.emit('download-progress', { percent: 10.9 });
  events.emit('download-progress', { percent: 55 });
  assert.deepEqual(told.shares, [0.1, 0.55], 'once per whole percent');
  events.emit('update-downloaded', { version: '9.9.9' });
  assert.deepEqual(updater.status(), { version: '9.9.9', ready: true, share: 1, waiting: false, failed: false });
  assert.equal(updater.notes, '<ul><li>A</li></ul>', 'the notes found stay');
  assert.equal(told.installs.length, 0, 'nothing installs by itself before the quit');
});

test('install asked during the download waits for its end, then closes the app', () => {
  const { updater, events, told } = fakeUpdater();
  assert.equal(updater.install(), false, 'nothing found');
  events.emit('update-available', { version: '9.9.9' });
  assert.equal(updater.install(), 'waiting');
  assert.equal(updater.status().waiting, true);
  assert.equal(told.installs.length, 0);
  assert.equal(updater.install(false), false, 'the wait can be cancelled');
  assert.equal(updater.status().waiting, false);
  updater.install();
  events.emit('update-downloaded', { version: '9.9.9' });
  assert.deepEqual(told.installs, [{ silent: false, run: true }], 'installed with its progress, then reopened');
});

test('a download that fails stops the wait, and the next check tries again', () => {
  const { updater, events, told } = fakeUpdater();
  let checks = 0;
  updater.updater.checkForUpdates = () => { checks += 1; return Promise.resolve(); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    events.emit('update-available', { version: '9.9.9' });
    updater.check();
    assert.equal(checks, 0, 'no second check while it downloads');
    updater.install();
    events.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual({ ...updater.status() }, { version: '9.9.9', ready: false, share: 0, waiting: false, failed: true });
  assert.equal(updater.install(), false, 'nothing to wait for');
  updater.check();
  assert.equal(checks, 1);
  events.emit('update-available', { version: '9.9.9' });
  assert.equal(updater.status().failed, false);
  assert.equal(told.installs.length, 0);
});

test('a download that ends during an export waits for the quit', () => {
  const { updater, events, told } = fakeUpdater({ busy: true });
  events.emit('update-available', { version: '9.9.9' });
  updater.install();
  events.emit('update-downloaded', { version: '9.9.9' });
  assert.equal(told.installs.length, 0);
  assert.equal(updater.status().ready, true);
});

test('a start during an install gives way, except the one the installer makes at its end', () => {
  const exe = 'C:\Users\me\AppData\Local\Programs\clipshelf\ClipShelf.exe';
  const running = () => true;
  assert.equal(startBlocked({ packaged: true, argv: [exe], installing: running }), true, 'opened by hand meanwhile');
  assert.equal(startBlocked({ packaged: true, argv: [exe, '--updated'], installing: running }), false, 'opened by the installer');
  assert.equal(startBlocked({ packaged: true, argv: [exe], installing: () => false }), false, 'no install');
  assert.equal(startBlocked({ packaged: false, argv: [exe], installing: running }), false, 'from the sources');
});
