// The icon of a program, read from the resources of the .exe file. Windows' thumbnails fail on many
// game programs and its file icons stop at 32 pixels, while most games ship a 256 pixel icon.
const fs = require('node:fs/promises');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_ENTRIES = 4096; // A resource table is small: more entries means a damaged file.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Reads `length` bytes at `position`, or fails when the file is shorter. */
async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead < length) throw new Error('The file ends too soon.');
  return buffer;
}

/** The resources of a PE file: a way to read them, and where they start. */
async function resourceSection(handle) {
  const magic = Buffer.alloc(2);
  await handle.read(magic, 0, 2, 0);
  if (magic.toString('latin1') !== 'MZ') return null; // Not a program.
  const dos = await readAt(handle, 0, 64);
  const pe = dos.readUInt32LE(60);
  const header = await readAt(handle, pe, 24);
  if (header.readUInt32LE(0) !== 0x4550) return null; // "PE\0\0"
  const sections = header.readUInt16LE(6);
  const optionalSize = header.readUInt16LE(20);
  const optional = await readAt(handle, pe + 24, optionalSize);
  // The data directories start later in 64-bit programs.
  const directories = optional.readUInt16LE(0) === 0x20b ? 112 : 96;
  if (optionalSize < directories + 24) return null;
  const rva = optional.readUInt32LE(directories + 16);
  if (!rva) return null;

  const table = await readAt(handle, pe + 24 + optionalSize, sections * 40);
  for (let i = 0; i < sections; i += 1) {
    const at = i * 40;
    const start = table.readUInt32LE(at + 12);
    const size = Math.max(table.readUInt32LE(at + 8), table.readUInt32LE(at + 16));
    if (rva >= start && rva < start + size) {
      const raw = table.readUInt32LE(at + 20);
      // Positions inside resources are given in memory; this turns them into positions in the file.
      return { root: raw + rva - start, fileOf: (address) => raw + address - start };
    }
  }
  return null;
}

/** The entries of one resource directory: [{ id, name, at, folder }]. */
async function directory(handle, section, offset) {
  const head = await readAt(handle, section.root + offset, 16);
  const count = head.readUInt16LE(12) + head.readUInt16LE(14);
  if (count > MAX_ENTRIES) throw new Error('Damaged resources.');
  const list = await readAt(handle, section.root + offset + 16, count * 8);
  return Array.from({ length: count }, (_, i) => {
    const name = list.readUInt32LE(i * 8);
    const target = list.readUInt32LE(i * 8 + 4);
    return {
      id: name & 0x80000000 ? null : name,
      at: target & 0x7fffffff,
      folder: Boolean(target & 0x80000000),
    };
  });
}

/** The bytes of the first language of a resource. */
async function data(handle, section, entry) {
  let leaf = entry;
  for (let depth = 0; leaf.folder && depth < 2; depth += 1) {
    [leaf] = await directory(handle, section, leaf.at);
    if (!leaf) return null;
  }
  if (leaf.folder) return null;
  const record = await readAt(handle, section.root + leaf.at, 16);
  const size = record.readUInt32LE(4);
  if (!size || size > MAX_IMAGE) return null;
  return readAt(handle, section.fileOf(record.readUInt32LE(0)), size);
}

/**
 * The first icon of a program, as Windows shows it: a PNG when its largest picture is one, else an
 * .ico holding every size. Resolves to { bytes, extension, width } or null when it has no icon.
 */
async function exeIcon(file) {
  const handle = await fs.open(file, 'r');
  try {
    const section = await resourceSection(handle);
    if (!section) return null;
    const types = await directory(handle, section, 0);
    const groups = types.find((type) => type.id === RT_GROUP_ICON && type.folder);
    const icons = types.find((type) => type.id === RT_ICON && type.folder);
    if (!groups || !icons) return null;
    // Named groups come first in the table, as Windows reads it.
    const [first] = await directory(handle, section, groups.at);
    const group = first && await data(handle, section, first);
    if (!group || group.length < 6) return null;

    const byId = new Map((await directory(handle, section, icons.at)).map((icon) => [icon.id, icon]));
    const images = [];
    for (let i = 0; i < group.readUInt16LE(4) && 6 + i * 14 + 14 <= group.length; i += 1) {
      const at = 6 + i * 14;
      const entry = byId.get(group.readUInt16LE(at + 12));
      const bytes = entry && await data(handle, section, entry);
      // A width of 0 means 256 pixels.
      if (bytes) images.push({ head: group.subarray(at, at + 12), bytes, width: group[at] || 256 });
    }
    if (!images.length) return null;

    const largest = images.reduce((best, image) => (image.width > best.width ? image : best));
    if (largest.bytes.subarray(0, 4).equals(PNG)) return { bytes: largest.bytes, extension: 'png', width: largest.width };
    return { bytes: icoFile(images), extension: 'ico', width: largest.width };
  } finally {
    await handle.close();
  }
}

/** An .ico file: the same entries as in the program, each followed by where its picture starts. */
function icoFile(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((image, i) => {
    image.head.copy(head, 6 + i * 16, 0, 8);
    head.writeUInt32LE(image.bytes.length, 6 + i * 16 + 8);
    head.writeUInt32LE(offset, 6 + i * 16 + 12);
    offset += image.bytes.length;
  });
  return Buffer.concat([head, ...images.map((image) => image.bytes)]);
}

module.exports = { exeIcon, icoFile };
