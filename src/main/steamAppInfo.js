// Steam keeps what it knows of every app of the account in appcache/appinfo.vdf, a binary file: names and
// the hashes of their icons. The pictures stay in appcache/librarycache after a game is uninstalled, so
// this file is what names them. It is only read, never changed.
const fs = require('node:fs/promises');
const path = require('node:path');

// Versions 27 to 29 of the file. Version 28 added a second hash to each entry; version 29 moved the keys
// to a table at the end of the file.
const MAGIC = { 0x07564427: 27, 0x07564428: 28, 0x07564429: 29 };
const MAX_DEPTH = 32;

class Reader {
  constructor(buffer, offset, end) {
    Object.assign(this, { buffer, offset, end });
  }

  need(bytes) {
    if (this.offset + bytes > this.end) throw new Error('appinfo.vdf ends inside an entry');
  }

  u8() { this.need(1); return this.buffer[this.offset++]; }

  u32() { this.need(4); const value = this.buffer.readUInt32LE(this.offset); this.offset += 4; return value; }

  skip(bytes) { this.need(bytes); this.offset += bytes; }

  text() {
    const stop = this.buffer.indexOf(0, this.offset);
    if (stop < 0 || stop >= this.end) throw new Error('appinfo.vdf has an unended text');
    const value = this.buffer.toString('utf8', this.offset, stop);
    this.offset = stop + 1;
    return value;
  }

  wideText() {
    let stop = this.offset;
    while (stop + 1 < this.end && this.buffer.readUInt16LE(stop) !== 0) stop += 2;
    if (stop + 1 >= this.end) throw new Error('appinfo.vdf has an unended text');
    const value = this.buffer.toString('utf16le', this.offset, stop);
    this.offset = stop + 2;
    return value;
  }
}

/** Reads one section of binary key values. Numbers that are not needed are skipped. */
function readSection(reader, key, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('appinfo.vdf nests too deep');
  const section = {};
  for (;;) {
    const type = reader.u8();
    if (type === 0x08 || type === 0x0b) return section;
    const name = key(reader);
    if (type === 0x00) section[name] = readSection(reader, key, depth + 1);
    else if (type === 0x01) section[name] = reader.text();
    else if (type === 0x05) section[name] = reader.wideText();
    else if (type === 0x02 || type === 0x03 || type === 0x04 || type === 0x06) section[name] = reader.u32();
    else if (type === 0x07 || type === 0x0a) reader.skip(8);
    else throw new Error(`appinfo.vdf has an unknown value type ${type}`);
  }
}

function keyTable(buffer, offset) {
  const reader = new Reader(buffer, offset, buffer.length);
  const keys = [];
  for (let count = reader.u32(); count > 0; count -= 1) keys.push(reader.text());
  return keys;
}

/**
 * The games named in appinfo.vdf: [{ id, name, icon, clienticon }]. `icon` names the small picture in
 * librarycache/<id>/, and `clienticon` the large one in steam/games/. A damaged entry is left out.
 */
function parseAppInfo(buffer) {
  const version = buffer.length >= 8 ? MAGIC[buffer.readUInt32LE(0)] : undefined;
  if (!version) return [];
  let offset = 8;
  let key = (reader) => reader.text();
  if (version >= 29) {
    if (buffer.length < 16) return [];
    let keys;
    try {
      keys = keyTable(buffer, Number(buffer.readBigInt64LE(8)));
    } catch {
      return []; // Steam was writing the file, or it was cut short: no key can be read.
    }
    key = (reader) => {
      const name = keys[reader.u32()];
      if (name === undefined) throw new Error('appinfo.vdf names a key it does not hold');
      return name;
    };
    offset = 16;
  }
  const games = [];
  while (offset + 8 <= buffer.length) {
    const id = buffer.readUInt32LE(offset);
    if (id === 0) break;
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    offset = end;
    try {
      // State, update time, token, hash, change number and, since version 28, the hash of the data.
      const reader = new Reader(buffer, start + 4 + 4 + 8 + 20 + 4 + (version >= 28 ? 20 : 0), end);
      if (reader.u8() !== 0x00) continue;
      key(reader);
      const common = readSection(reader, key).common;
      if (!common?.name || String(common.type).toLowerCase() !== 'game') continue;
      games.push({ id: String(id), name: common.name, icon: hash(common.icon), clienticon: hash(common.clienticon) });
    } catch {
      // The next entry starts where its size says, whatever was wrong in this one.
    }
  }
  return games;
}

const hash = (value) => (typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null);

async function readAppInfo(steam) {
  if (!steam) return [];
  const buffer = await fs.readFile(path.join(steam, 'appcache', 'appinfo.vdf')).catch(() => null);
  return buffer ? parseAppInfo(buffer) : [];
}

module.exports = { parseAppInfo, readAppInfo };
