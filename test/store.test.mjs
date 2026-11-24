import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Store } = require('../src/main/store');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clips.json');
  const backups = path.join(dir, 'backups');
  let date = new Date(2026, 10, 24, 9);
  const open = (count = 14) => new Store(file, {}, { backups: count, now: () => date });
  const write = (store, data) => {
    store.data = data;
    store.save();
    store.flush();
  };
  return {
    file, backups, open, write,
    setDay: (day) => { date = new Date(2026, 10, day, 9); },
    copies: () => (fs.existsSync(backups) ? fs.readdirSync(backups).sort() : []),
    copy: (name) => JSON.parse(fs.readFileSync(path.join(backups, name), 'utf8')),
  };
}

test('a store without backups writes no daily copy', (t) => {
  const { file, backups } = setup(t);
  fs.writeFileSync(file, '{"a":1}');
  const store = new Store(file);
  store.data.a = 2;
  store.save();
  store.flush();
  assert.equal(fs.existsSync(backups), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 2);
});

test('the first save of a day keeps the version from before it', (t) => {
  const { file, open, write, copies, copy, setDay } = setup(t);
  fs.writeFileSync(file, '{"tags":["old"]}');
  const store = open();
  write(store, { tags: ['first'] });
  write(store, { tags: ['second'] });
  assert.deepEqual(copies(), ['clips-2026-11-24.json']);
  assert.deepEqual(copy('clips-2026-11-24.json'), { tags: ['old'] });

  setDay(25);
  write(store, { tags: ['third'] });
  assert.deepEqual(copies(), ['clips-2026-11-24.json', 'clips-2026-11-25.json']);
  assert.deepEqual(copy('clips-2026-11-25.json'), { tags: ['second'] });
});

test('a first start, with nothing to keep yet, writes no copy', (t) => {
  const { open, write, copies } = setup(t);
  write(open(), { tags: ['new'] });
  assert.deepEqual(copies(), []);
});

test('only the newest copies are kept, however far apart their days are', (t) => {
  const { file, open, write, copies, setDay } = setup(t);
  fs.writeFileSync(file, '{}');
  const store = open(3);
  for (const day of [1, 2, 10, 20, 28]) {
    setDay(day);
    write(store, { day });
  }
  assert.deepEqual(copies(), ['clips-2026-11-10.json', 'clips-2026-11-20.json', 'clips-2026-11-28.json']);
});

test('a broken file and a broken .bak fall back to the newest daily copy', (t) => {
  const { file, backups, open } = setup(t);
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, 'clips-2026-11-20.json'), '{"tags":["older"]}');
  fs.writeFileSync(path.join(backups, 'clips-2026-11-22.json'), '{"tags":["newer"]}');
  fs.writeFileSync(path.join(backups, 'settings-2026-11-23.json'), '{"tags":["other file"]}');
  fs.writeFileSync(file, '{"tags":[');
  fs.writeFileSync(`${file}.bak`, '');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  assert.deepEqual(open().data, { tags: ['newer'] });
  assert.ok(errors.some((line) => line.includes('clips-2026-11-22.json')));
});
