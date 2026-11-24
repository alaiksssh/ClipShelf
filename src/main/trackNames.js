// OBS writes the name of each track in moov/trak/udta/name, which ffprobe does not report.
const fs = require('node:fs/promises');

const MAX_NAME = 256;
const MAX_BOXES = 4096; // Per level, in case of a damaged file.

async function readAt(handle, position, length) {
  const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The boxes between two positions. Only their headers are read. */
async function boxesIn(handle, start, end) {
  const boxes = [];
  let at = start;
  while (at + 8 <= end && boxes.length < MAX_BOXES) {
    const header = await readAt(handle, at, 16);
    if (header.length < 8) break;
    let size = header.readUInt32BE(0);
    let body = 8;
    if (size === 1 && header.length === 16) {
      size = Number(header.readBigUInt64BE(8));
      body = 16;
    } else if (size === 0) {
      size = end - at; // Runs to the end of its parent.
    }
    if (size < body || at + size > end) break;
    boxes.push({ type: header.toString('latin1', 4, 8), start: at + body, end: at + size });
    at += size;
  }
  return boxes;
}

/** Returns a Map of track id to name. Empty for anything that is not MP4 or MOV. */
async function readTrackNames(file) {
  const names = new Map();
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const moov = (await boxesIn(handle, 0, size)).find((box) => box.type === 'moov');
    if (!moov) return names;

    for (const trak of await boxesIn(handle, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      const children = await boxesIn(handle, trak.start, trak.end);
      const header = children.find((box) => box.type === 'tkhd');
      const userData = children.find((box) => box.type === 'udta');
      if (!header || !userData) continue;
      const nameBox = (await boxesIn(handle, userData.start, userData.end)).find((box) => box.type === 'name');
      if (!nameBox) continue;

      const head = await readAt(handle, header.start, 24);
      // The two dates before the id are 64-bit in version 1 of the box.
      const idAt = head[0] === 1 ? 20 : 12;
      if (head.length < idAt + 4) continue;

      const raw = await readAt(handle, nameBox.start, Math.min(MAX_NAME, nameBox.end - nameBox.start));
      const name = raw.toString('utf8').replace(/[\u0000-\u001f]/g, '').trim();
      if (name) names.set(head.readUInt32BE(idAt), name);
    }
  } catch (error) {
    // Names are a bonus: the clip must still open without them.
    console.error(`Cannot read track names of ${file}:`, error.message);
  } finally {
    await handle?.close();
  }
  return names;
}

module.exports = { readTrackNames };
