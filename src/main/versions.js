// Saving a montage over its clip, and going back.
//
// Saving replaces the clip for good: the user asked for it, clips are too big to keep twice.
// The replacement is a single rename, so there is no moment without a complete file at the path of
// the clip, and a failure leaves the original as it was. Both the original and the new file are
// decoded whole before, because this PC can flip bits in memory.
//
// Versions 1.2 to 1.4.0 kept the original in a `.clipshelf-originals` folder next to the clip, and
// `meta.original` points to it by content key. Going back to those still works.
const fs = require('node:fs/promises');
const { existsSync, constants } = require('node:fs');
const path = require('node:path');
const { exportClip } = require('./exporter');
const { probe, checkDecodes, Damaged } = require('./ffmpeg');
const { fingerprint } = require('./library');
const { t } = require('./i18n');

const BACKUP_DIR = '.clipshelf-originals';
const FORMATS = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mov', '.mkv': 'matroska' };
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 24; // Readers of our own, like a thumbnail being made, let go within seconds.
const RETRY_DELAY = 250;
const LENGTH_TOLERANCE = 1; // Seconds.

const keyOfFile = async (file) => fingerprint(file, (await fs.stat(file)).size);

async function linkOrCopy(from, to) {
  try {
    await fs.link(from, to);
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    await fs.copyFile(from, to, constants.COPYFILE_EXCL); // No hard links on this disk.
  }
}

async function whenUnlocked(task) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!LOCKED.has(error.code)) throw error;
      if (attempt === RETRIES) {
        throw new Error(t('job.locked'));
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

/** Puts `next` at `target`, in place of `current`. Either all of it happens or none. */
async function swap(next, current, target) {
  if (target.toLowerCase() === current.toLowerCase()) {
    await whenUnlocked(() => fs.rename(next, target));
    return;
  }
  // Another extension: the new file has to exist before the old one goes.
  try {
    await linkOrCopy(next, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(t('job.nameTaken', { name: path.basename(target) }));
    throw error;
  }
  try {
    await whenUnlocked(() => fs.unlink(current));
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(next, { force: true }).catch(() => {});
}

async function checkUnchanged(clip) {
  const { size, mtimeMs } = await fs.stat(clip.path);
  if (`${size}:${mtimeMs}` !== clip.stamp) {
    throw new Error(t('job.changed'));
  }
}

class Versions {
  constructor({ library, trashItem }) {
    this.library = library;
    this.meta = library.meta;
    this.trashItem = trashItem;
  }

  /** The files kept for a content key, newest first. */
  chainOf(key) {
    const files = [];
    const seen = new Set();
    let current = key;
    while (current && !seen.has(current)) {
      seen.add(current);
      const original = this.meta.data[current]?.original;
      if (!original) break;
      files.push(original.file);
      current = original.key;
    }
    return files;
  }

  /** Files kept for a key that no clip of the library can go back to any more. */
  unused(key) {
    const files = this.chainOf(key);
    if (!files.length) return files;
    const used = new Set([...this.library.clips.values()].flatMap((clip) => this.chainOf(clip.key)));
    return files.filter((file) => !used.has(file) && existsSync(file));
  }

  saveMeta() {
    this.meta.save();
    this.meta.flush(); // On disk before any file moves.
  }

  async overwrite(clip, request, { signal, onProgress }) {
    if (clip.busy || clip.broken || !clip.key) throw new Error(t('job.cannotNow'));
    await checkUnchanged(clip);

    const extension = path.extname(clip.path);
    const format = FORMATS[extension.toLowerCase()];
    const target = format ? clip.path : path.join(path.dirname(clip.path), `${clip.name}.mp4`);
    if (!format && existsSync(target)) throw new Error(t('job.nameTaken', { name: path.basename(target) }));

    // The original goes for good, so it must read back whole first. On this kind of PC a clip that
    // stays long in memory, like one being edited, can come back with flipped bits.
    try {
      await checkDecodes(clip.path, {
        signal, duration: clip.duration, onProgress: (value) => onProgress(value, 'source'),
      });
    } catch (error) {
      if (!(error instanceof Damaged)) throw error;
      throw new Error(t('job.sourceDamaged'));
    }

    return exportClip(clip, { ...request, mode: 'auto' }, {
      format: format || 'mp4',
      signal,
      onProgress,
      save: (out, options) => this.replace(clip, { out, options, target, signal, onProgress }),
    });
  }

  async replace(clip, { out, options, target, signal, onProgress = () => {} }) {
    const info = await probe(out);
    if (Math.abs(info.duration - options.length) > LENGTH_TOLERANCE || info.audio.length !== options.groups.length) {
      throw new Error(t('job.incomplete'));
    }
    const key = await keyOfFile(out);
    if (key === clip.key) throw new Error(t('job.nothingChanged'));

    const dir = path.dirname(clip.path);
    const next = path.join(dir, `.${key}.clipshelf-part`);
    const before = this.meta.data[key];

    try {
      // Removed first: writing into a leftover link would write into the file it links to.
      await fs.rm(next, { force: true });
      // Moved when on the same disk, so that the clip never needs twice its size.
      await fs.rename(out, next).catch(() => fs.copyFile(out, next));
      const { atime, mtime } = await fs.stat(clip.path);
      // Keeps its place in the library, yet differs from the original for the index.
      await fs.utimes(next, atime, new Date(mtime.getTime() + 10));
      if (await keyOfFile(next) !== key) throw new Error(t('job.copyFailed'));
      // Checked where it will stay, after the move or the copy.
      await checkDecodes(next, {
        signal, duration: options.length, onProgress: (value) => onProgress(value, 'check'),
      }).catch((error) => {
        if (!(error instanceof Damaged)) throw error;
        throw new Error(t('job.newDamaged'));
      });

      const moments = await this.library.momentsAfter(clip.key, options.pieces);
      const from = this.meta.data[clip.key] || {};
      this.meta.data[key] = {
        ...from,
        edit: null,
        moments,
        thumb: await this.library.thumbAfter(clip.key, options.pieces),
        capturedGame: from.capturedGame || clip.guessedGame,
        original: undefined,
      };
      this.saveMeta();

      signal?.throwIfAborted();
      await checkUnchanged(clip);
      await swap(next, clip.path, target);
    } catch (error) {
      await fs.rm(next, { force: true }).catch(() => {});
      if (before) this.meta.data[key] = before;
      else delete this.meta.data[key];
      this.saveMeta();
      throw error;
    }

    const id = await this.library.adopt(target, info, key);
    // What older versions kept of this clip can no longer be gone back to: it goes to the Recycle Bin.
    for (const file of this.unused(clip.key)) {
      await this.trashItem(file).catch((error) => console.error(`Cannot trash ${file}:`, error.message));
      await fs.rmdir(path.dirname(file)).catch(() => {}); // Only when empty.
    }
    return { id, path: target, size: (await fs.stat(target)).size };
  }

  async revert(clip) {
    const original = this.meta.data[clip.key]?.original;
    if (!original || !existsSync(original.file)) throw new Error(t('job.noPrevious'));
    if (await keyOfFile(original.file) !== original.key) throw new Error(t('job.previousDamaged'));
    await checkUnchanged(clip);

    const dir = path.dirname(clip.path);
    const target = path.join(dir, clip.name + original.extension);
    if (target.toLowerCase() !== clip.path.toLowerCase() && existsSync(target)) {
      throw new Error(t('job.nameTaken', { name: path.basename(target) }));
    }
    const info = await probe(original.file);
    const next = path.join(dir, `.${original.key}.clipshelf-part`);
    // A readable name, since this is what the Recycle Bin will show.
    let replaced;
    for (let n = 1; !replaced; n += 1) {
      const name = `${clip.name} (${t('job.overwrittenName')}${n > 1 ? ` ${n}` : ''})${path.extname(clip.path)}`;
      if (!existsSync(path.join(dir, name))) replaced = path.join(dir, name);
    }

    let aside = false;
    try {
      await fs.rm(next, { force: true });
      await linkOrCopy(original.file, next);
      await linkOrCopy(clip.path, replaced);
      aside = true;
      await swap(next, clip.path, target);
    } catch (error) {
      await fs.rm(next, { force: true }).catch(() => {});
      if (aside && existsSync(clip.path)) await fs.rm(replaced, { force: true }).catch(() => {});
      throw error;
    }

    const current = this.meta.data[clip.key];
    const restored = {
      ...this.meta.data[original.key],
      favorite: current.favorite,
      tags: current.tags,
      title: current.title,
      category: current.category,
    };
    if (current.game !== undefined) restored.game = current.game;
    this.meta.data[original.key] = restored;
    this.saveMeta();

    const trashed = await this.trashItem(replaced).then(() => true, () => false);
    const id = await this.library.adopt(target, info, original.key);

    // The clip is that file again, so its spare link can go.
    if (this.unused(clip.key).includes(original.file) && await keyOfFile(target) === original.key) {
      await fs.rm(original.file, { force: true }).catch(() => {});
      await fs.rmdir(path.dirname(original.file)).catch(() => {}); // Only when empty.
    }
    return { id, trashed };
  }
}

module.exports = { Versions, BACKUP_DIR, FORMATS, linkOrCopy, swap, checkUnchanged, keyOfFile, whenUnlocked };
