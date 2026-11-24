// Discord exports are only there to be pasted, so they stay out of the exports and of the library.
// Each one gets a folder of its own in the app data: the file keeps the name of the clip, which
// Discord shows, even when the same clip is sent twice. A folder goes once the clipboard no longer
// holds its file. Ctrl+V needs the file, and so does Discord while it uploads it, so a file is never
// removed in its first minutes.
const fs = require('node:fs/promises');
const path = require('node:path');

const GRACE = 2 * 60e3;
// Reading the clipboard starts PowerShell: not on every focus of the window.
const READ_EVERY = 30e3;

/**
 * `held()` resolves to the paths of the files on the clipboard. `now` is for the tests.
 */
class DiscordFiles {
  constructor({ dir, held, now = Date.now }) {
    Object.assign(this, { dir, held, now });
    this.kept = null; // The folder of a file the clipboard could not take, left to be dragged by hand.
    this.running = null;
    this.lastRead = -Infinity;
  }

  /** Moves the encoded file into a new folder, under the name of the clip. Copied from another disk. */
  async place(out, name) {
    await fs.mkdir(this.dir, { recursive: true });
    const folder = await fs.mkdtemp(path.join(this.dir, `${this.now()}-`));
    const target = path.join(folder, `${name}.mp4`);
    await fs.rename(out, target).catch(() => fs.copyFile(out, target));
    return { path: target, size: (await fs.stat(target)).size };
  }

  /** After a new export, only its own file may be the one to drag by hand. */
  sent(file, copied) {
    this.kept = copied ? null : path.dirname(file);
  }

  /** Removes the folders the clipboard no longer holds. Resolves to the removed folders. */
  clear({ force = false } = {}) {
    this.running ??= this.sweep(force).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async sweep(force) {
    const names = await fs.readdir(this.dir).catch(() => []);
    const now = this.now();
    // A name that does not start with a time is not one of ours, or is old: it may go.
    const old = names.map((name) => path.join(this.dir, name))
      .filter((folder) => folder !== this.kept && !(now - Number(path.basename(folder).split('-')[0]) < GRACE));
    if (!old.length || (!force && now - this.lastRead < READ_EVERY)) return [];
    this.lastRead = now;
    const held = await this.held().catch((error) => {
      console.error('Cannot read the clipboard:', error.message);
      return null;
    });
    if (!held) return []; // Unknown: nothing goes until the clipboard can be read.
    const holding = new Set(held.map((file) => path.dirname(path.resolve(file)).toLowerCase()));
    const removed = [];
    for (const folder of old) {
      if (holding.has(folder.toLowerCase())) continue;
      try {
        await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(folder);
      } catch (error) {
        console.error(`Cannot remove ${folder}:`, error.message); // Still open somewhere: next time.
      }
    }
    return removed;
  }
}

module.exports = { DiscordFiles, GRACE, READ_EVERY };
