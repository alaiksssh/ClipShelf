// Index of the clips on disk. User metadata is keyed by a content fingerprint,
// so favourites, tags and edits survive renames and moves.
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { probe, limiter } = require('./ffmpeg');
const { filmFrames } = require('./derived');
const { guessGame, guessDate, validName } = require('./naming');
const { cleanTitle, cleanCategory, cleanTag } = require('./organizer');
const { t } = require('./i18n');

const EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.flv', '.ts']);
const SETTLE_MS = 4000;
const SAMPLE_BYTES = 65536;
const PROBE_VERSION = 2; // Raise when probe() learns something, so that known clips are read again.
const MOVES_KEPT = 5000;

const momentsModule = import('../shared/moments.mjs');
const idOf = (file) => createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 20);

async function fingerprint(file, size) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const hash = createHash('sha1').update(String(size));
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    for (const position of [0, Math.floor(size / 2), Math.max(0, size - SAMPLE_BYTES)]) {
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, position);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex').slice(0, 20);
  } finally {
    await handle.close();
  }
}

async function walk(root) {
  const files = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Protected or disconnected folder.
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  await visit(root);
  return files;
}

/** A name that no file in `dir` has yet: "clip (2).mp4" next to "clip.mp4". */
function freeName(dir, name, extension) {
  for (let n = 1; n < 1000; n += 1) {
    const file = path.join(dir, `${name}${n > 1 ? ` (${n})` : ''}${extension}`);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error(t('files.tooMany'));
}

class Library extends EventEmitter {
  /** `games` holds the games the user added, whose spelling wins. */
  constructor({ settings, meta, index, obsLogs, games = null }) {
    super();
    Object.assign(this, { settings, meta, index, obsLogs, games });
    this.clips = new Map();
    // Old id -> new id. What the page asked for just before a move, such as pictures of a film
    // strip, still finds the clip.
    this.moved = new Map();
    this.watchers = [];
    this.scanning = null;
    this.dirty = false;
    this.timer = null;
  }

  start() {
    this.stop();
    for (const root of this.settings.data.folders) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_, name) => {
          const ext = name ? path.extname(String(name)).toLowerCase() : '';
          // No extension means a folder was probably moved or deleted.
          if (!ext || EXTENSIONS.has(ext)) this.schedule(1000);
        });
        watcher.on('error', (error) => console.error(`Watcher ${root}:`, error.message));
        this.watchers.push(watcher);
      } catch (error) {
        console.error(`Cannot watch ${root}:`, error.message);
      }
    }
    return this.scan();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  schedule(delay) {
    // Not a debounce: OBS writes continuously, which would postpone the scan forever.
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan().catch((error) => console.error('Scan failed:', error));
    }, delay);
  }

  scan() {
    if (this.scanning) {
      this.dirty = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.dirty = false;
        await this.scanOnce();
      } while (this.dirty);
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async scanOnce() {
    const found = new Map();
    // Deepest root first, so nested roots give the most precise game guess.
    const roots = [...this.settings.data.folders].sort((a, b) => b.length - a.length);
    for (const root of roots) {
      for (const file of await walk(root)) {
        if (!found.has(idOf(file))) found.set(idOf(file), { file, root });
      }
    }

    await this.obsLogs.refresh();
    const next = new Map();
    const limit = limiter(6);
    await Promise.all([...found].map(([id, { file, root }]) => limit(async () => {
      try {
        const stat = await fs.promises.stat(file);
        const base = {
          id,
          path: file,
          root,
          mtime: stat.mtimeMs,
          name: path.parse(file).name,
          size: stat.size,
          guessedGame: guessGame(file, root),
          date: guessDate(file, stat.mtimeMs),
        };
        const stamp = `${stat.size}:${stat.mtimeMs}`;
        let info = this.index.data[id];
        if (info?.stamp !== stamp || info.version !== PROBE_VERSION) {
          if (info?.stamp !== stamp && (Math.abs(Date.now() - stat.mtimeMs) < SETTLE_MS || !stat.size)) {
            next.set(id, { ...base, busy: true, duration: 0, audio: [] }); // Still being written.
            return;
          }
          const key = await fingerprint(file, stat.size);
          try {
            info = { stamp, version: PROBE_VERSION, key, ...(await probe(file)) };
            this.index.data[id] = info;
            this.index.save();
          } catch {
            // Not cached, so it is probed again on the next scan.
            info = { key, broken: true, duration: 0, audio: [] };
          }
        }
        const captured = this.capturedGame(file, info);
        next.set(id, { ...base, ...info, guessedGame: captured || base.guessedGame });
      } catch {
        // Moved, deleted or locked during the scan; a later event brings it back.
      }
    })));

    this.clips = next;
    if ([...next.values()].some((clip) => clip.busy)) this.schedule(SETTLE_MS);
    this.emit('change');
  }

  /**
   * OBS only keeps its latest logs, so what they said is saved with the clip. The process is saved
   * too: a game added later with that program then names the clip.
   */
  capturedGame(file, { key, duration }) {
    const saved = this.meta.data[key] || {};
    if (saved.capturedGame) {
      // Clips read before 1.6 have no process yet. The logs are asked once, while they still exist.
      if (saved.capturedProcess === undefined && duration) {
        this.meta.data[key] = { ...saved, capturedProcess: this.obsLogs.captureFor(file, duration)?.executable || '' };
        this.meta.save();
      }
      const process = this.meta.data[key].capturedProcess;
      return (process && this.games?.byProgram(process)) || saved.capturedGame;
    }
    if (!duration) return '';
    const found = this.obsLogs.captureFor(file, duration);
    if (found) {
      this.meta.data[key] = { ...saved, capturedGame: found.game, capturedProcess: found.executable };
      this.meta.save();
    }
    return found?.game || '';
  }

  get(id) {
    let clip = this.clips.get(id);
    for (let hops = 0; !clip && this.moved.has(id) && hops < 50; hops += 1) {
      id = this.moved.get(id);
      clip = this.clips.get(id);
    }
    if (!clip) throw new Error(t('clip.notFound'));
    return clip;
  }

  list() {
    // One spelling per game: "Valorant" wins over "VALORANT".
    const spelling = new Map();
    const clips = [...this.clips.values()].map(({ stamp, guessedGame, ...clip }) => {
      const meta = this.meta.data[clip.key] || {};
      const named = meta.game ?? guessedGame;
      const game = (named && this.games?.spelling(named)) || named;
      const known = spelling.get(game.toLowerCase());
      if (!known || known === known.toUpperCase()) spelling.set(game.toLowerCase(), game);
      return {
        ...clip,
        filmFrames: filmFrames(clip.duration),
        game,
        favorite: Boolean(meta.favorite),
        title: meta.title || '',
        hideTallies: Boolean(meta.hideTallies),
        category: meta.category || '',
        tags: meta.tags || [],
        moments: meta.moments?.items || [],
        detected: Boolean(meta.moments?.detected),
        replay: Boolean(meta.moments?.replay),
        rounds: Array.isArray(meta.moments?.rounds) ? meta.moments.rounds : null,
        edit: meta.edit || null,
        exported: Boolean(meta.exported),
        hasPrevious: Boolean(meta.original && fs.existsSync(meta.original.file)),
        thumb: this.thumbOf(clip),
      };
    });
    return clips.map((clip) => ({ ...clip, game: spelling.get(clip.game.toLowerCase()) }));
  }

  update(ids, patch) {
    for (const id of ids) {
      const { key } = this.get(id);
      if (!key) continue;
      const meta = { ...this.meta.data[key] };
      if (typeof patch.favorite === 'boolean') meta.favorite = patch.favorite;
      if (typeof patch.hideTallies === 'boolean') meta.hideTallies = patch.hideTallies;
      if (typeof patch.game === 'string') meta.game = patch.game.trim().slice(0, 60);
      if (typeof patch.title === 'string') meta.title = cleanTitle(patch.title);
      if (typeof patch.category === 'string') meta.category = cleanCategory(patch.category);
      const added = [patch.addTag, ...(Array.isArray(patch.addTags) ? patch.addTags : [])]
        .map(cleanTag).filter(Boolean);
      if (added.length) meta.tags = [...new Set([...(meta.tags || []), ...added])];
      const removed = [patch.removeTag, ...(Array.isArray(patch.removeTags) ? patch.removeTags : [])];
      if (removed.some(Boolean)) meta.tags = (meta.tags || []).filter((tag) => !removed.includes(tag));
      if ('edit' in patch) meta.edit = patch.edit;
      // A time of the file; anything else goes back to the picture chosen by the app.
      if ('thumb' in patch) meta.thumb = Number.isFinite(patch.thumb) && patch.thumb >= 0 ? patch.thumb : undefined;
      this.meta.data[key] = meta;
    }
    this.meta.save();
    this.emit('change');
  }

  setMoments(key, moments) {
    this.meta.data[key] = { ...this.meta.data[key], moments };
    this.meta.save();
    this.emit('change');
  }

  async setDetected(key, { version, replay, events, rounds = null }) {
    const { mergeDetected } = await momentsModule;
    // Read now: marks may have been added while the video was being read.
    const items = mergeDetected(this.meta.data[key]?.moments?.items || [], events);
    this.setMoments(key, { detected: version, replay, items, rounds });
  }

  /** The moments of the file that a montage of this clip becomes. */
  async momentsAfter(key, pieces) {
    const { carryMoments, carryRounds } = await momentsModule;
    const moments = this.meta.data[key]?.moments;
    return moments && { ...moments, items: carryMoments(moments.items || [], pieces), rounds: carryRounds(moments.rounds, pieces) };
  }

  /** The picture chosen for the card, as a time of the file, or null. */
  thumbOf(clip) {
    const time = clip.key && this.meta.data[clip.key]?.thumb;
    return Number.isFinite(time) ? time : null;
  }

  /** Where the chosen picture is in the file that a montage of this clip becomes. */
  async thumbAfter(key, pieces) {
    const { carryTime } = await momentsModule;
    return carryTime(this.meta.data[key]?.thumb, pieces);
  }

  async addExport(file, source, pieces = []) {
    const key = await fingerprint(file, (await fs.promises.stat(file)).size);
    const moments = await this.momentsAfter(source.key, pieces);
    const from = this.meta.data[source.key] || {};
    this.meta.data[key] = {
      exported: true,
      game: from.game ?? source.guessedGame,
      title: from.title,
      category: from.category,
      tags: [...(from.tags || [])],
      moments,
      thumb: await this.thumbAfter(source.key, pieces),
    };
    this.meta.save();
    this.schedule(SETTLE_MS + 300);
  }

  async rename(id, name) {
    const clip = this.get(id);
    if (clip.busy) throw new Error(t('clip.recording'));
    if (!validName(name)) throw new Error(t('files.badName'));
    const target = path.join(path.dirname(clip.path), name + path.extname(clip.path));
    if (target === clip.path) return id;
    // fs.rename overwrites silently, so check first (a change of case alone is allowed).
    if (idOf(target) !== id && fs.existsSync(target)) throw new Error(t('files.taken'));
    return this.relocate(clip, target);
  }

  /**
   * Into another folder of the same disk, under a free name. With `quiet`, the caller says when
   * the list changed, once for many clips.
   */
  async move(id, dir, { quiet = false } = {}) {
    const clip = this.get(id);
    if (clip.busy) throw new Error(t('clip.recording'));
    await fs.promises.mkdir(dir, { recursive: true });
    const extension = path.extname(clip.path);
    return this.relocate(clip, freeName(dir, path.parse(clip.path).name, extension), { quiet });
  }

  /** The index follows the file, so that it is not read again. */
  async relocate(clip, target, { quiet = false } = {}) {
    const { id } = clip;
    const newId = idOf(target);
    await fs.promises.rename(clip.path, target);
    if (this.index.data[id]) {
      this.index.data[newId] = this.index.data[id];
      if (newId !== id) delete this.index.data[id];
      this.index.save();
    }
    this.clips.delete(id);
    this.clips.set(newId, { ...clip, id: newId, path: target, name: path.parse(target).name });
    if (newId !== id) {
      this.moved.delete(newId); // A clip is at that path again.
      this.moved.set(id, newId);
      if (this.moved.size > MOVES_KEPT) this.moved.delete(this.moved.keys().next().value);
    }
    if (!quiet) this.emit('change');
    this.schedule(500);
    return newId;
  }

  /** A file that ClipShelf just put in place: it is known at once, without waiting for it to settle. */
  async adopt(file, info, key) {
    const { size, mtimeMs } = await fs.promises.stat(file);
    const id = idOf(file);
    this.index.data[id] = { ...info, stamp: `${size}:${mtimeMs}`, version: PROBE_VERSION, key };
    this.index.save();
    await this.scan();
    return id;
  }

  forget(id) {
    this.clips.delete(id);
    this.emit('change');
  }
}

module.exports = { Library, fingerprint };
