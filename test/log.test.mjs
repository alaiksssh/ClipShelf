import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Log, NAME, OLD_NAME } = require('../src/main/log');

function setup(t, options) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-')), 'logs');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const log = new Log(dir, options);
  const read = (name = NAME) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { dir, log, read };
}

test('the log makes its folder and writes timestamped lines', (t) => {
  const { log, read } = setup(t);
  log.write('INFO', 'Start', { version: '1.8.1' });
  assert.match(read(), /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO Start \{ version: '1\.8\.1' \}\n$/);
});

test('an error keeps its stack, indented under its line', (t) => {
  const { log, read } = setup(t);
  log.write('ERROR', 'Export failed:', new Error('boom'));
  const lines = read().trimEnd().split('\n');
  assert.match(lines[0], /ERROR Export failed: Error: boom$/);
  assert.ok(lines.length > 1 && lines.slice(1).every((line) => line.startsWith('    ')));
});

test('a full log becomes the old one, and only one old log is kept', (t) => {
  const { dir, log, read } = setup(t, { maxBytes: 200 });
  for (let i = 0; i < 20; i += 1) log.write('INFO', `line ${i} ${'x'.repeat(40)}`);
  assert.ok(fs.statSync(path.join(dir, NAME)).size <= 200);
  assert.ok(fs.statSync(path.join(dir, OLD_NAME)).size <= 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), [OLD_NAME, NAME].sort());
  assert.match(read(), /line 19/);
  assert.doesNotMatch(read(OLD_NAME), /line 19/);
});

test('the size of an existing log counts after a restart', (t) => {
  const { dir, log } = setup(t, { maxBytes: 200 });
  log.write('INFO', 'x'.repeat(150));
  new Log(dir, { maxBytes: 200 }).write('INFO', 'y'.repeat(150));
  assert.ok(fs.existsSync(path.join(dir, OLD_NAME)));
});

test('a log that cannot be written stays silent', (t) => {
  const { dir, log } = setup(t);
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, 'a file where the folder was');
  assert.doesNotThrow(() => log.write('ERROR', 'lost'));
});

test('console errors and warnings go to the log and still print', (t) => {
  const { log, read } = setup(t);
  const printed = [];
  const target = { error: (...parts) => printed.push(['error', ...parts]), warn: (...parts) => printed.push(['warn', ...parts]) };
  log.captureConsole(target);
  target.error('Cannot save:', 'disk full');
  target.warn('Slow probe');
  assert.deepEqual(printed, [['error', 'Cannot save:', 'disk full'], ['warn', 'Slow probe']]);
  assert.match(read(), /ERROR Cannot save: disk full\n.*WARN Slow probe\n$/);
});

test('crashes of the main process are written', (t) => {
  const { log, read } = setup(t);
  const target = new EventEmitter();
  log.captureCrashes(target);
  target.emit('uncaughtExceptionMonitor', new Error('fatal one'), 'uncaughtException');
  assert.match(read(), /FATAL uncaughtException: Error: fatal one/);
  assert.equal(target.listenerCount('unhandledRejection'), 1);
});
