// One folder per game on disk, inside the clip folder: "I:\ClipShelf\Clips\Valorant\". The user turns
// it on per clip folder. A clip moves once OBS has finished writing it, and again when its game changes.
// Moves stay on the same disk, so each one is a rename: the file is never copied or rewritten.
const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n');

const OTHER = 'Other'; // As in shared/gameList.mjs: the clips without a game.
// OBS may still hold a file a little after its last write, and a file it holds cannot be renamed.
const SETTLE_MS = 30 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 30 * 60 * 1000;
const NAME_LENGTH = 80;

/** The folder of a game, as Windows accepts it: "Call of Duty: Warzone" becomes "Call of Duty Warzone". */
function folderName(game) {
  const name = String(game || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH).replace(/[. ]+$/, '');
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? OTHER : name;
}

const key = (dir) => path.resolve(dir).toLowerCase();
const samePath = (a, b) => key(a) === key(b);
const inside = (file, dir) => key(file).startsWith(`${key(dir)}${path.sep}`);

/**
 * Where the clips of the sorted folders go, from `library.list()` (games spelled as shown).
 * `skip` holds ids to leave for now: open in the editor, or that could not move a moment ago.
 * `waiting` receives the clips that are too fresh, with the time they may move.
 */
function planMoves(clips, { roots, exportDir = '', now = Date.now(), skip = new Set(), waiting = [] }) {
  const moves = [];
  for (const clip of clips) {
    if (!clip.root || !roots.some((root) => samePath(root, clip.root))) continue;
    // Being written, unreadable, or an export: those stay where they are.
    if (clip.busy || clip.broken || !clip.key || clip.exported || skip.has(clip.id)) continue;
    if (exportDir && (samePath(path.dirname(clip.path), exportDir) || inside(clip.path, exportDir))) continue;
    const dir = path.join(clip.root, folderName(clip.game));
    if (samePath(path.dirname(clip.path), dir)) continue;
    if (now - clip.mtime < SETTLE_MS) {
      waiting.push(clip.mtime + SETTLE_MS);
      continue;
    }
    moves.push({ id: clip.id, from: clip.path, dir, game: clip.game || OTHER });
  }
  return moves;
}

/** What the first sorting of a folder would do, to show before it starts. */
function preview(clips, { root, exportDir = '' }) {
  const mine = clips.filter((clip) => clip.root && samePath(clip.root, root));
  const moves = planMoves(mine.map((clip) => ({ ...clip, mtime: 0 })), { roots: [root], exportDir });
  const games = new Map();
  for (const move of moves) {
    const row = games.get(move.dir) || { game: move.game, dir: move.dir, count: 0, size: 0 };
    row.count += 1;
    row.size += mine.find((clip) => clip.id === move.id)?.size || 0;
    games.set(move.dir, row);
  }
  const busy = mine.filter((clip) => clip.busy).length;
  return {
    root,
    moving: moves.length,
    placed: mine.length - moves.length - busy,
    busy,
    broken: mine.filter((clip) => clip.broken).length,
    games: [...games.values()].sort((a, b) => b.count - a.count),
  };
}

class GameFolders {
  /**
   * `canMove()` is false while an export, overwrite or compression runs.
   * `leave()` gives the ids to leave in place, such as the clip open in the editor.
   * `withFilesFree(task)` pauses what reads clips in the background.
   */
  constructor({ library, settings, journal, canMove = () => true, leave = () => [], withFilesFree = (task) => task() }) {
    Object.assign(this, { library, settings, journal, canMove, leave, withFilesFree });
    if (!Array.isArray(settings.data.sortRoots)) settings.data.sortRoots = [];
    if (!Array.isArray(settings.data.madeFolders)) settings.data.madeFolders = [];
    this.failed = new Map(); // id -> { until: time it may be tried again, tries }
    this.running = null;
    this.again = false;
    this.timer = null;
    this.timerAt = 0;
  }

  /** The sorted folders that are still clip folders. */
  roots() {
    const { folders, sortRoots } = this.settings.data;
    return sortRoots.filter((root) => folders.some((folder) => samePath(folder, root)));
  }

  isOn(root) {
    return this.roots().some((other) => samePath(other, root));
  }

  preview(root) {
    return preview(this.library.list(), { root, exportDir: this.settings.data.exportDir });
  }

  async turn(root, on) {
    const { data } = this.settings;
    if (!data.folders.some((folder) => samePath(folder, root))) throw new Error(t('sort.unknownFolder'));
    data.sortRoots = data.sortRoots.filter((other) => !samePath(other, root));
    if (on) data.sortRoots.push(root);
    this.settings.save();
    return on ? this.run() : { moved: 0, failed: [] };
  }

  /** One pass at a time. A pass asked meanwhile runs right after. */
  run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let total = { moved: 0, failed: [] };
      do {
        this.again = false;
        const { moved, failed } = await this.pass();
        total = { moved: total.moved + moved, failed: [...total.failed, ...failed] };
      } while (this.again);
      return total;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async pass() {
    const roots = this.roots();
    if (!roots.length) return { moved: 0, failed: [] };
    if (!this.canMove()) {
      this.later(RETRY_MS);
      return { moved: 0, failed: [] };
    }
    const now = Date.now();
    // An id the page knew before a rename is followed to the clip it now names.
    const current = (id) => {
      try {
        return this.library.get(id).id;
      } catch {
        return id;
      }
    };
    const skip = new Set([...this.leave().map(current), ...[...this.failed].filter(([, { until }]) => until > now).map(([id]) => id)]);
    const waiting = [...this.failed.values()].map(({ until }) => until).filter((until) => until > now);
    const moves = planMoves(this.library.list(), { roots, exportDir: this.settings.data.exportDir, now, skip, waiting });
    if (waiting.length) this.later(Math.min(...waiting) - now + 500);
    if (!moves.length) return { moved: 0, failed: [] };

    const failed = [];
    let moved = 0;
    await this.withFilesFree(async () => {
      for (const move of moves) {
        try {
          const existed = fs.existsSync(move.dir);
          const id = await this.library.move(move.id, move.dir, { quiet: true });
          moved += 1;
          this.failed.delete(move.id);
          if (!existed) this.made(move.dir, roots);
          this.journal?.(move.from, this.library.get(id).path);
          await this.tidy(path.dirname(move.from), roots);
        } catch (error) {
          // Still held by OBS or another program: tried again later, less and less often.
          const tries = (this.failed.get(move.id)?.tries || 0) + 1;
          const delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (tries - 1));
          this.failed.set(move.id, { until: Date.now() + delay, tries });
          this.later(delay + 500);
          failed.push({ file: move.from, reason: error.message });
        }
      }
    });
    if (moved) this.library.emit('change');
    return { moved, failed };
  }

  /** Another pass after `delay`, unless one is already planned sooner. */
  later(delay) {
    const at = Date.now() + Math.max(1000, delay);
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().catch((error) => console.error('Sorting by game failed:', error.message));
    }, at - Date.now());
    this.timer.unref?.();
  }

  /** Folders that ClipShelf made, so that only those are removed once empty. */
  made(dir, roots) {
    const { madeFolders } = this.settings.data;
    if (!roots.some((root) => samePath(path.dirname(dir), root))) return;
    if (madeFolders.some((other) => samePath(other, dir))) return;
    madeFolders.push(dir);
    this.settings.save();
  }

  /** A game folder made by ClipShelf goes once its last clip has left. Other folders stay, even empty. */
  async tidy(dir, roots) {
    const { madeFolders } = this.settings.data;
    if (!madeFolders.some((other) => samePath(other, dir))) return;
    if (!roots.some((root) => samePath(path.dirname(dir), root))) return;
    try {
      await fs.promises.rmdir(dir); // Only when empty.
      this.settings.data.madeFolders = madeFolders.filter((other) => !samePath(other, dir));
      this.settings.save();
    } catch {
      // Something else is still in it.
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { GameFolders, planMoves, preview, folderName, OTHER };
