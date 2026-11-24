// The grass block of Minecraft, taken flat from the textures of the game installed on this PC.
const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const SIDE = 'assets/minecraft/textures/block/grass_block_side.png';

/** Reads some entries of a zip file (a .jar), without unpacking the rest. */
async function readZip(file, names) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 65557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return new Map();
    const count = tail.readUInt16LE(end + 10);
    const directory = Buffer.alloc(tail.readUInt32LE(end + 12));
    await handle.read(directory, 0, directory.length, tail.readUInt32LE(end + 16));

    const found = new Map();
    for (let at = 0, i = 0; i < count && at + 46 <= directory.length; i += 1) {
      const method = directory.readUInt16LE(at + 10);
      const packed = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extra = directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
      const offset = directory.readUInt32LE(at + 42);
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extra;
      if (!names.includes(name) || packed > 1e6) continue;
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, offset);
      const data = Buffer.alloc(packed);
      await handle.read(data, 0, packed, offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28));
      if (method === 0) found.set(name, data);
      else if (method === 8) found.set(name, zlib.inflateRawSync(data));
    }
    return found;
  } finally {
    await handle.close();
  }
}

/**
 * A texture made large with its pixels kept sharp, as Minecraft shows them. Animated textures are
 * strips of squares: only the first is kept. `texture` and the result are { width, height, data } in RGBA.
 */
function enlarge(texture, size = 256) {
  const side = Math.min(texture.width, texture.height);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (Math.floor((y * side) / size) * texture.width + Math.floor((x * side) / size)) * 4;
      data.set(texture.data.subarray(from, from + 4), (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** The flat side of the grass block, from the first game file that has it, or null. */
async function grassBlock(jars, { decodePng, encodePng }) {
  for (const jar of jars) {
    const files = await readZip(jar, [SIDE]).catch(() => new Map());
    if (!files.has(SIDE)) continue;
    const side = decodePng(files.get(SIDE));
    if (!side?.width) continue;
    return encodePng(enlarge(side));
  }
  return null;
}

module.exports = { readZip, enlarge, grassBlock, SIDE };
