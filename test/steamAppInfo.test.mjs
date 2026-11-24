import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseAppInfo } = require('../src/main/steamAppInfo');
const { GameIcons } = require('../src/main/gameIcons');

const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const text = (value) => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);

/** Writes appinfo.vdf as Steam does: version 29 keeps its keys in a table at the end, 28 inline. */
function appInfo(version, apps) {
  const keys = [];
  const key = (name) => {
    if (version < 29) return text(name);
    if (!keys.includes(name)) keys.push(name);
    return u32(keys.indexOf(name));
  };
  const section = (values) => Buffer.concat([...Object.entries(values).map(([name, value]) => {
    if (typeof value === 'object') return Buffer.concat([Buffer.from([0x00]), key(name), section(value)]);
    if (typeof value === 'number') return Buffer.concat([Buffer.from([0x02]), key(name), u32(value)]);
    if (typeof value === 'bigint') {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64LE(value);
      return Buffer.concat([Buffer.from([0x07]), key(name), bytes]);
    }
    return Buffer.concat([Buffer.from([0x01]), key(name), text(value)]);
  }), Buffer.from([0x08])]);
  const entries = apps.map(({ id, data, raw }) => {
    const body = raw ?? Buffer.concat([Buffer.from([0x00]), key('appinfo'), section(data), Buffer.from([0x08])]);
    const head = Buffer.alloc(4 + 4 + 8 + 20 + 4 + (version >= 28 ? 20 : 0));
    return Buffer.concat([u32(id), u32(head.length + body.length), head, body]);
  });
  const header = version >= 29 ? 16 : 8;
  const content = Buffer.concat([...entries, u32(0)]);
  const start = Buffer.alloc(header);
  start.writeUInt32LE(0x07564400 + Number(`0x${version}`));
  start.writeUInt32LE(1, 4);
  if (version < 29) return Buffer.concat([start, content]);
  start.writeBigInt64LE(BigInt(header + content.length), 8);
  return Buffer.concat([start, content, u32(keys.length), ...keys.map(text)]);
}

const small = 'b'.repeat(40);
const large = 'c'.repeat(40);
const apps = [
  { id: 1245620, data: { appid: 1245620, common: { name: 'ELDEN RING', type: 'Game', icon: small, clienticon: large, gameid: 1245620n } } },
  { id: 7, data: { appid: 7, common: { name: 'ELDEN RING Soundtrack', type: 'Music', icon: small } } },
  { id: 8, raw: Buffer.from([0x00, 0xff, 0xff]) }, // Damaged: the next entry is still read.
  { id: 9, data: { appid: 9, common: { name: 'Trackmania', type: 'game', icon: 'not a hash' } } },
];

test('appinfo.vdf names the games Steam knows, in versions 28 and 29, past a damaged entry', () => {
  for (const version of [28, 29]) {
    assert.deepEqual(parseAppInfo(appInfo(version, apps)), [
      { id: '1245620', name: 'ELDEN RING', icon: small, clienticon: large },
      { id: '9', name: 'Trackmania', icon: null, clienticon: null },
    ], `version ${version}`);
  }
  assert.deepEqual(parseAppInfo(Buffer.from('not appinfo')), []);
  assert.deepEqual(parseAppInfo(appInfo(29, apps).subarray(0, 60)), []); // Cut short.
});

test('an uninstalled Steam game takes its logo from the pictures Steam keeps', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-steam-logos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('steam/appcache/appinfo.vdf', appInfo(29, apps));
  write(`steam/appcache/librarycache/1245620/${small}.jpg`, 'small');
  write('steam/appcache/librarycache/1245620/header.jpg', 'header');
  const icons = () => new GameIcons({
    dir: path.join(root, 'logos'),
    env: {},
    findSteam: async () => path.join(root, 'steam'),
    readShortcut: () => ({}),
    xboxRoots: [],
  });
  const first = icons();
  await first.refresh(['Elden Ring', 'Trackmania']);
  assert.equal(fs.readFileSync(first.fileOf('eldenring'), 'utf8'), 'small');
  assert.equal(first.fileOf('trackmania'), null); // No picture kept.

  // The large icon of a desktop shortcut has its own hash and wins.
  write(`steam/steam/games/${large}.ico`, 'large');
  const second = icons();
  await second.automatic('Elden Ring');
  assert.equal(fs.readFileSync(second.fileOf('eldenring'), 'utf8'), 'large');
});
