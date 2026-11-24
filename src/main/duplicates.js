// Replays of the OBS replay buffer that hold the same moments twice, and making them hold it once.
//
// The buffer keeps the last seconds of the game. Saving twice within that time writes the time in
// between into both files, as the very same packets. The times of the files only choose which
// pairs are worth reading: whether two files share anything comes from their packets (packets.js).
//
// Two ways out, both chosen by the user. Joining makes one clip from the first picture of the
// first replay to the last picture of the last one. Cutting keeps each replay with its end, where
// the moment it was saved for is, and starts the next one where the one before stops, at the key
// frame before. Both copy packets and never encode: the new file is checked packet by packet
// against the originals, then decoded whole, before it takes the place of a clip. The originals go
// to the Recycle Bin under a readable name, like those of a compression, and a replay that another
// one holds whole goes there as it is.
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ffmpeg, probe, checkDecodes, Damaged } = require('./ffmpeg');
const { readPackets, align, holds, junction, trimPlan } = require('./packets');
const { FORMATS, linkOrCopy, swap, checkUnchanged, keyOfFile, whenUnlocked } = require('./versions');
const { t } = require('./i18n');

const joins = import('../shared/joins.mjs');

const MAX_LENGTH = 15 * 60; // Seconds. Longer files are recordings, too long to read in the background.
const MIN_LENGTH = 2; // Seconds.
const SLACK = 10 * 1000; // Milliseconds: a file is written a moment after its last picture.
const EDGE = 0.02; // Seconds, between what the length of a file says and what its packets say.
const SETTLE = 5000; // Milliseconds after a change of the library, so that a scan is over.
const PAIRS_KEPT = 5000;
const TIME_TOLERANCE = 0.0015; // Seconds: rounding between time bases, a tenth of a frame.
const COPY_SHARE = 0.15; // Of the progress of a file. Copying packets is quick, decoding the result is not.
const EXTENSIONS = { mp4: '.mp4', mov: '.mov', matroska: '.mkv' };
const AUTO_NAME = /20\d\d[-_.]\d\d[-_.]\d\d|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

const formatOf = (clip) => FORMATS[path.extname(clip.path).toLowerCase()];
/** The name the user gave the file, or '' for the one the recorder gave. */
const handName = (clip) => (AUTO_NAME.test(clip.name) ? '' : clip.name);

function usable(clip) {
  return !clip.busy && !clip.broken && Boolean(clip.key) && Boolean(clip.codec) && Boolean(formatOf(clip))
    && clip.duration >= MIN_LENGTH && clip.duration <= MAX_LENGTH;
}

/** What one encoder setting gives every time. */
const alike = (a, b) => a.codec === b.codec && a.width === b.width && a.height === b.height
  && Math.abs(a.fps - b.fps) < 0.5 && a.audio.length === b.audio.length;

/** When a clip may have been filmed: it ends when its file was last written. */
const windowOf = (clip) => [clip.mtime - clip.duration * 1000 - SLACK, clip.mtime + SLACK];

/** Pairs of clips filmed at times that cross, which may share pictures. */
function candidatePairs(clips) {
  const sorted = clips.filter(usable).map((clip) => ({ clip, window: windowOf(clip) }))
    .sort((a, b) => a.window[0] - b.window[0]);
  const pairs = [];
  for (const [i, { clip, window }] of sorted.entries()) {
    for (let j = i + 1; j < sorted.length && sorted[j].window[0] < window[1]; j += 1) {
      if (alike(clip, sorted[j].clip)) pairs.push([clip, sorted[j].clip]);
    }
  }
  return pairs;
}

const pairKey = (a, b) => (a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`);

/** Seconds of [start, end] that the other spans also cover. */
function covered({ start, end }, others) {
  const spans = others.map((other) => [Math.max(start, other.start), Math.min(end, other.end)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reached = start;
  for (const [a, b] of spans) {
    if (b <= reached) continue;
    total += b - Math.max(a, reached);
    reached = b;
  }
  return total;
}

function describe(members, byId) {
  const chain = members.filter((member) => !member.inside);
  const length = Math.max(...members.map((member) => member.end));
  const total = members.reduce((sum, member) => sum + member.end - member.start, 0);
  const saved = members.reduce((sum, member) => {
    const { size, duration } = byId.get(member.id);
    if (member.inside) return sum + size;
    const next = chain[chain.indexOf(member) + 1];
    return next ? sum + (size * Math.max(0, member.end - next.start)) / duration : sum;
  }, 0);
  for (const member of members) member.shared = covered(member, members.filter((other) => other !== member));
  return { ids: members.map((member) => member.id), clips: members, length, shared: Math.max(0, total - length), saved: Math.round(saved) };
}

/**
 * Clips that share pictures, as groups. `links` are [a, b, shift]: a time t of b is the time
 * t + shift of a. In a group, clips are in the order they start; `start` and `end` are seconds from
 * the start of the first one. `inside` marks a clip that another one holds whole, as
 * `contains(outer, inner)` says; by default, their times do. Newest groups first.
 */
function groupsOf(clips, links, { contains } = {}) {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const edges = new Map();
  const add = (from, to, shift) => edges.set(from, [...(edges.get(from) || []), [to, shift]]);
  for (const [a, b, shift] of links) {
    add(a.id, b.id, shift);
    add(b.id, a.id, -shift);
  }
  const within = contains || ((outer, inner) => outer.start <= inner.start + EDGE && outer.end >= inner.end - EDGE);
  const seen = new Set();
  const groups = [];
  for (const root of edges.keys()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const starts = new Map([[root, 0]]);
    for (const queue = [root]; queue.length;) {
      const id = queue.shift();
      for (const [other, shift] of edges.get(id)) {
        if (seen.has(other)) continue;
        seen.add(other);
        starts.set(other, starts.get(id) + shift);
        queue.push(other);
      }
    }
    const members = [...starts].map(([id, start]) => ({ id, start, end: start + byId.get(id).duration }))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const origin = members[0].start;
    for (const member of members) {
      member.start -= origin;
      member.end -= origin;
    }
    for (const [i, member] of members.entries()) {
      member.inside = members.slice(0, i).some((outer) => !outer.inside && within(outer, member));
    }
    groups.push(describe(members, byId));
  }
  const newest = (group) => Math.max(...group.ids.map((id) => byId.get(id).mtime));
  return groups.sort((a, b) => newest(b) - newest(a));
}

/** A free name next to the clip, which the Recycle Bin will show. */
function asideName(clip, label) {
  const dir = path.dirname(clip.path);
  const extension = path.extname(clip.path);
  for (let n = 1; ; n += 1) {
    const file = path.join(dir, `${clip.name} (${label}${n > 1 ? ` ${n}` : ''})${extension}`);
    if (!existsSync(file)) return file;
  }
}

/** The names of the sound tracks, which a copy of the packets alone would lose. */
const trackNames = (audio) => audio.flatMap((track, i) => (track.name
  ? [`-metadata:s:a:${i}`, `title=${track.name}`, `-metadata:s:a:${i}`, `handler_name=${track.name}`]
  : []));

const containerArgs = (format) => (format === 'matroska' ? ['-f', format] : ['-movflags', '+faststart', '-f', format]);

/**
 * Whether `count` packets of `got` from `at` are those of `want` from `from`, each moved by the
 * same time. Returns that time, or null.
 */
function sameRun(got, at, want, from, count) {
  if (!got || !count || at + count > got.packets.length || from + count > want.packets.length) return null;
  let offset = null;
  for (let k = 0; k < count; k += 1) {
    const a = got.packets[at + k];
    const b = want.packets[from + k];
    if (a.hash !== b.hash) return null;
    const delta = a.pts * got.timeBase - b.pts * want.timeBase;
    if (offset === null) offset = delta;
    else if (Math.abs(delta - offset) > TIME_TOLERANCE) return null;
  }
  return offset;
}

const micro = (seconds) => `${Math.round(seconds * 1e6)}us`;

/**
 * Whether two files that share pictures share too little to cut without encoding: less than the
 * time between two key frames, as a cut leaves them. Such pairs are not shown.
 */
function settled(x, y, shift) {
  const [first, second] = shift >= 0 ? [x, y] : [y, x];
  if (holds(first, second) || holds(second, first)) return false;
  try {
    return !trimPlan(first, second);
  } catch {
    return false;
  }
}

class Duplicates extends EventEmitter {
  /** `busy()` is true while a job replaces files: nothing is read meanwhile. */
  constructor({ library, store, trashItem, busy = () => false, read = readPackets }) {
    super();
    Object.assign(this, { library, store, trashItem, busy, read });
    this.meta = library.meta;
    if (!this.store.data.pairs || typeof this.store.data.pairs !== 'object') this.store.data.pairs = {};
    this.failed = new Set(); // Pairs that could not be read, until the next start.
    this.timer = null;
    this.running = null;
    this.current = null;
    this.holds = 0;
    this.stopped = false;
    library.on('change', () => this.schedule());
  }

  get pairs() {
    return this.store.data.pairs;
  }

  /** Not a debounce: OBS writes for a long time, and scans follow each other meanwhile. */
  schedule(delay = SETTLE) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // A job that replaces files puts the look off: it is tried again later, not dropped.
      if (this.busy()) {
        this.schedule(delay);
        return;
      }
      this.look().catch((error) => console.error('Looking for duplicate replays failed:', error.message));
    }, delay);
  }

  waiting() {
    return candidatePairs([...this.library.clips.values()])
      .filter(([a, b]) => !this.pairs[pairKey(a, b)] && !this.failed.has(pairKey(a, b)));
  }

  /** Always a promise: a look that cannot start now resolves at once. */
  look() {
    if (this.running || this.holds || this.stopped || this.busy()) return this.running ?? Promise.resolve();
    this.running = this.lookOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Reads the pairs not read yet, one after the other and behind everything else. */
  async lookOnce() {
    const read = new Map(); // The last files read: one clip is often in several pairs.
    const packetsOf = async (clip, signal) => {
      if (!read.has(clip.key)) {
        if (read.size >= 3) read.delete(read.keys().next().value);
        read.set(clip.key, await this.read(clip.path, { signal, low: 'idle' }));
      }
      return read.get(clip.key);
    };
    for (const [a, b] of this.waiting()) {
      if (this.holds || this.stopped || this.busy()) return;
      const [x, y] = a.key < b.key ? [a, b] : [b, a];
      const controller = new AbortController();
      this.current = controller;
      try {
        const [px, py] = [await packetsOf(x, controller.signal), await packetsOf(y, controller.signal)];
        const link = align(px, py);
        // A file rewritten meanwhile has another key: it is read on the next look.
        if (!(await this.unchanged(x)) || !(await this.unchanged(y))) continue;
        this.keep(pairKey(x, y), link ? link.shift : null, Boolean(link) && settled(px, py, link.shift));
      } catch (error) {
        if (controller.signal.aborted) return;
        this.failed.add(pairKey(x, y));
        console.error(`Cannot compare ${x.name} with ${y.name}:`, error.message);
      } finally {
        this.current = null;
      }
      this.emit('change');
    }
  }

  async unchanged(clip) {
    try {
      const { size, mtimeMs } = await fs.stat(clip.path);
      return `${size}:${mtimeMs}` === clip.stamp;
    } catch {
      return false;
    }
  }

  keep(key, shift, done = false) {
    this.pairs[key] = { shift, settled: done, at: Date.now() };
    const keys = Object.keys(this.pairs);
    if (keys.length > PAIRS_KEPT) {
      keys.sort((a, b) => this.pairs[a].at - this.pairs[b].at);
      for (const old of keys.slice(0, keys.length - PAIRS_KEPT)) delete this.pairs[old];
    }
    this.store.save();
  }

  /**
   * What the library shows: { pending, groups }. `pending` counts the pairs not compared yet, and
   * each group is as `groupsOf` gives it.
   */
  summary() {
    const clips = [...this.library.clips.values()].filter(usable);
    const links = [];
    let pending = 0;
    for (const [a, b] of candidatePairs(clips)) {
      const known = this.pairs[pairKey(a, b)];
      if (!known) {
        if (!this.failed.has(pairKey(a, b))) pending += 1;
        continue;
      }
      if (typeof known.shift !== 'number' || known.settled) continue;
      links.push(a.key < b.key ? [a, b, known.shift] : [b, a, known.shift]);
    }
    return { pending, groups: groupsOf(clips, links) };
  }

  /** Nothing may be reading a file that gets replaced, renamed or binned. */
  async withFilesFree(task) {
    this.holds += 1;
    try {
      this.current?.abort();
      await this.running;
      return await task();
    } finally {
      this.holds -= 1;
      if (!this.holds) this.schedule();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.current?.abort();
  }

  /**
   * Joins (`mode` 'join') or cuts (`mode` 'trim') the clips of one group, as they are now: they are
   * read again and compared again first. Resolves to { id, name, before, after, trashed, left }.
   * `leave` are clips that must stay as they are, such as the one open in the editor.
   */
  async resolve(ids, mode, { signal, onProgress = () => {}, leave = [] } = {}) {
    const clips = ids.map((id) => this.library.get(id));
    const last = clips.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const name = this.meta.data[last.key]?.title || last.name;
    for (const clip of clips) {
      if (!usable(clip)) throw new Error(t('dup.notNow'));
      if (leave.includes(clip.id)) throw new Error(t('dup.open'));
      await checkUnchanged(clip);
    }
    onProgress(0, 'read');
    const files = new Map();
    for (const clip of clips) files.set(clip.id, await this.read(clip.path, { signal, low: true }));
    const links = [];
    for (const [i, a] of clips.entries()) {
      for (const b of clips.slice(i + 1)) {
        const link = align(files.get(a.id), files.get(b.id));
        if (link) links.push([a, b, link.shift]);
      }
    }
    const groups = groupsOf(clips, links, { contains: (outer, inner) => holds(files.get(outer.id), files.get(inner.id)) });
    if (groups.length !== 1 || groups[0].ids.length !== clips.length) throw new Error(t('dup.changed'));
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    const members = groups[0].clips.map((member) => ({ ...member, clip: byId.get(member.id), file: files.get(member.id) }));
    const chain = members.filter((member) => !member.inside);
    const inside = members.filter((member) => member.inside);
    const before = clips.reduce((sum, clip) => sum + clip.size, 0);
    const result = mode === 'trim'
      ? await this.cutAll(chain, inside, { signal, onProgress })
      : await this.joinAll(chain, inside, { signal, onProgress });
    const after = (await Promise.all(result.kept.map((file) => fs.stat(file).then((stat) => stat.size, () => 0))))
      .reduce((sum, size) => sum + size, 0);
    return { name, before, after, trashed: result.trashed, left: result.left, id: result.id };
  }

  /** The marks of a clip that goes away, and the moment it was saved, on the clock of another one. */
  marksOf(member, shift) {
    const meta = this.meta.data[member.clip.key] || {};
    const marks = (meta.moments?.items || []).filter((moment) => moment.kind === 'mark')
      .map((mark) => ({ ...mark, time: mark.time + shift }));
    return [...marks, { time: member.clip.duration + shift, name: meta.title || handName(member.clip) }];
  }

  saveMeta() {
    this.meta.save();
    this.meta.flush(); // On disk before any file moves.
  }

  /** A clip that another one holds whole goes to the Recycle Bin, and what it had goes to the other. */
  async binInside(member, outer, intoKey = outer.clip.key) {
    const { joinDetails, marksInto, joinThumb } = await joins;
    const own = this.meta.data[member.clip.key] || {};
    const target = this.meta.data[intoKey] || {};
    const length = outer.clip.duration;
    this.meta.data[intoKey] = {
      ...target,
      ...joinDetails([target, own]),
      moments: marksInto(target.moments, this.marksOf(member, member.start - outer.start), { length }),
      // The picture chosen for the clip that stays wins over that of the one that goes.
      thumb: joinThumb([{ meta: own, shift: member.start - outer.start }, { meta: target }]),
    };
    this.saveMeta();
    try {
      await checkUnchanged(member.clip);
      await this.trashItem(member.clip.path);
    } catch (error) {
      console.error(`Cannot bin ${member.clip.path}:`, error.message);
      return false;
    }
    this.library.forget(member.clip.id);
    return true;
  }

  async cutAll(chain, inside, { signal, onProgress }) {
    const left = [];
    let trashed = true;
    for (const member of inside) {
      const outer = chain.find((candidate) => holds(candidate.file, member.file));
      if (!(await this.binInside(member, outer))) left.push({ name: member.clip.name, reason: t('dup.locked') });
    }
    // The last first: each cut reads only the clip before it, which is still as it was read.
    const cuts = chain.length - 1;
    let done = 0;
    for (let k = cuts; k > 0; k -= 1) {
      const step = (value, phase) => onProgress((cuts - k + value) / cuts, phase);
      try {
        const result = await this.cut(chain[k - 1], chain[k], { signal, onProgress: step });
        if (!result) {
          left.push({ name: chain[k].clip.name, reason: t('dup.tooShort') });
          continue;
        }
        trashed &&= result.trashed;
        done += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        left.push({ name: chain[k].clip.name, reason: error.message });
      }
    }
    if (!done && !inside.length) throw new Error(left[0]?.reason || t('dup.tooShort'));
    return { id: chain.at(-1).clip.id, trashed, left, kept: chain.map((member) => member.clip.path) };
  }

  /** `next` starts where `prev` stops. Null when they share less than the time between two key frames. */
  async cut(prev, next, { signal, onProgress }) {
    const { joinMoments, joinEdit, marksInto, joinThumb } = await joins;
    const plan = trimPlan(prev.file, next.file);
    if (!plan) return null;
    const { clip, file } = next;
    const format = formatOf(clip);
    const out = path.join(path.dirname(clip.path), `.trim-${process.pid}-${Date.now()}.clipshelf-part`);
    const keys = [];
    const saved = new Map();
    let aside = null;
    let info;
    try {
      await ffmpeg([
        '-copyts', '-i', clip.path, ...file.streams.flatMap((stream) => ['-map', `0:${stream.index}`]), '-c', 'copy',
        // Packets are dropped by their number: a time could fall between two of them.
        ...plan.drops.flatMap((drop, s) => (drop ? [`-bsf:${s}`, `noise=drop=lt(n\\,${drop})`] : [])),
        '-output_ts_offset', micro(-plan.start), ...trackNames(clip.audio), ...containerArgs(format), '-y', out,
      ], { signal, low: true });
      onProgress(COPY_SHARE / 2, 'copy');

      const got = await this.read(out, { signal, low: true });
      let base = null;
      for (const [s, stream] of file.streams.entries()) {
        const count = stream.packets.length - plan.drops[s];
        const offset = got.streams.length === file.streams.length && got.streams[s].packets.length === count
          ? sameRun(got.streams[s], 0, stream, plan.drops[s], count) : null;
        if (offset === null || (base !== null && Math.abs(offset - base) > TIME_TOLERANCE)) throw new Error(t('dup.copyFailed'));
        base ??= offset;
      }
      info = await probe(out);
      await checkDecodes(out, {
        signal, duration: info.duration, onProgress: (value) => onProgress(COPY_SHARE + (1 - COPY_SHARE) * value, 'check'),
      }).catch((error) => {
        if (!(error instanceof Damaged)) throw error;
        throw new Error(t('dup.damaged'));
      });

      const { atime, mtime } = await fs.stat(clip.path);
      await fs.utimes(out, atime, new Date(mtime.getTime() + 10)); // Its place in the library stays.
      const key = await keyOfFile(out);
      const own = this.meta.data[clip.key] || {};
      const part = { meta: own, clip, from: plan.start, to: Infinity, shift: -plan.start };
      for (const changed of [key, prev.clip.key]) saved.set(changed, this.meta.data[changed]);
      keys.push(key);
      // A picture chosen in the part that goes is not given to the clip before: it was chosen for this card.
      this.meta.data[key] = {
        ...own, moments: joinMoments([part], { length: info.duration }), edit: joinEdit([part], info), thumb: joinThumb([part]),
      };
      // Marks in the part that goes are in the clip before.
      const marks = (own.moments?.items || []).filter((moment) => moment.kind === 'mark' && moment.time < plan.start)
        .map((mark) => ({ ...mark, time: mark.time + next.start - prev.start }));
      if (marks.length) {
        const target = this.meta.data[prev.clip.key] || {};
        this.meta.data[prev.clip.key] = { ...target, moments: marksInto(target.moments, marks, { length: prev.clip.duration }) };
      }
      this.saveMeta();

      signal?.throwIfAborted();
      await checkUnchanged(clip);
      aside = asideName(clip, t('dup.beforeTrim'));
      await linkOrCopy(clip.path, aside);
      await swap(out, clip.path, clip.path);
    } catch (error) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (aside && existsSync(clip.path)) await fs.rm(aside, { force: true }).catch(() => {});
      for (const [changed, value] of saved) {
        if (value) this.meta.data[changed] = value;
        else delete this.meta.data[changed];
      }
      if (saved.size) this.saveMeta();
      throw error;
    }

    const trashed = await this.trashItem(aside).then(() => true, (error) => {
      console.error(`Cannot trash ${aside}:`, error.message);
      return false;
    });
    const id = await this.library.adopt(clip.path, info, keys[0]);
    return { id, trashed };
  }

  /** One clip from the first picture of the first replay to the last picture of the last one. */
  async joinAll(chain, inside, { signal, onProgress }) {
    const last = chain.at(-1);
    const left = [];
    if (chain.length === 1) {
      for (const member of inside) {
        if (!(await this.binInside(member, last))) left.push({ name: member.clip.name, reason: t('dup.locked') });
      }
      onProgress(1);
      return { id: last.clip.id, trashed: true, left, kept: [last.clip.path] };
    }
    const format = formatOf(last.clip);
    if (chain.some((member) => formatOf(member.clip) !== format)) throw new Error(t('dup.formats'));

    const target = last.clip.path;
    const out = path.join(path.dirname(target), `.join-${process.pid}-${Date.now()}.clipshelf-part`);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'clipshelf-join-'));
    let key = null;
    let before;
    let lastAside = null;
    let info;
    try {
      await this.writeJoined(chain, { work, out, format, signal });
      onProgress(COPY_SHARE, 'copy');
      info = await probe(out);
      await checkDecodes(out, {
        signal, duration: info.duration, onProgress: (value) => onProgress(COPY_SHARE + (1 - COPY_SHARE) * value, 'check'),
      }).catch((error) => {
        if (!(error instanceof Damaged)) throw error;
        throw new Error(t('dup.damaged'));
      });

      const { atime, mtime } = await fs.stat(target);
      await fs.utimes(out, atime, new Date(mtime.getTime() + 10)); // Where the last one was in the library.
      key = await keyOfFile(out);
      before = this.meta.data[key];
      this.meta.data[key] = await this.joinedMeta(chain, inside, info);
      this.saveMeta();

      signal?.throwIfAborted();
      for (const member of [...chain, ...inside]) await checkUnchanged(member.clip);
      lastAside = asideName(last.clip, t('dup.beforeJoin'));
      await linkOrCopy(target, lastAside);
      await swap(out, target, target);
    } catch (error) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (lastAside) await fs.rm(lastAside, { force: true }).catch(() => {});
      if (key) {
        if (before) this.meta.data[key] = before;
        else delete this.meta.data[key];
        this.saveMeta();
      }
      throw error;
    } finally {
      await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }

    // The joined file holds every picture now: what follows can only leave a copy too many.
    const asides = [lastAside];
    for (const member of chain.slice(0, -1)) {
      const aside = asideName(member.clip, t('dup.beforeJoin'));
      try {
        await whenUnlocked(() => fs.rename(member.clip.path, aside));
        asides.push(aside);
        this.library.forget(member.clip.id);
      } catch (error) {
        console.error(`Cannot set ${member.clip.path} aside:`, error.message);
        left.push({ name: member.clip.name, reason: t('dup.locked') });
      }
    }
    let trashed = true;
    for (const aside of asides) {
      trashed = await this.trashItem(aside).then(() => trashed, (error) => {
        console.error(`Cannot trash ${aside}:`, error.message);
        return false;
      });
    }
    for (const member of inside) {
      try {
        await this.trashItem(member.clip.path);
        this.library.forget(member.clip.id);
      } catch (error) {
        console.error(`Cannot trash ${member.clip.path}:`, error.message);
        left.push({ name: member.clip.name, reason: t('dup.locked') });
      }
    }
    const id = await this.library.adopt(target, info, key);
    return { id, trashed, left, kept: [target] };
  }

  /** Names, tags, marks, kills and montage of the joined clip, from those of its parts. */
  async joinedMeta(chain, inside, info) {
    const { joinDetails, joinMoments, joinEdit, marksInto, joinThumb } = await joins;
    const last = chain.at(-1).clip;
    const metas = chain.map((member) => this.meta.data[member.clip.key] || {});
    // Where two parts hold the same time, the montage of the one that has one wins, else the earlier one.
    const edge = (k) => (metas[k + 1].edit && !metas[k].edit ? chain[k + 1].start : chain[k].end);
    const parts = chain.map((member, k) => ({
      meta: metas[k],
      clip: member.clip,
      from: k ? edge(k - 1) - member.start : 0,
      to: k < chain.length - 1 ? edge(k) - member.start : Infinity,
      shift: member.start,
    }));
    const saves = chain.slice(0, -1).map((member, k) => ({ time: member.end, name: metas[k].title || handName(member.clip) }));
    let moments = joinMoments(parts, { length: info.duration, saves });
    const marks = inside.flatMap((member) => this.marksOf(member, member.start));
    if (marks.length) moments = marksInto(moments, marks, { length: info.duration });
    const details = joinDetails([...metas, ...inside.map((member) => this.meta.data[member.clip.key])]);
    if (!details.title && !handName(last)) {
      const named = [...chain, ...inside].map((member) => member.clip).find((clip) => handName(clip));
      if (named) details.title = named.name.slice(0, 60);
    }
    // Replays of the chain win over those held whole inside them, and later ones over earlier ones.
    const held = inside.map((member) => ({ meta: this.meta.data[member.clip.key], shift: member.start }));
    const thumb = joinThumb([...held, ...parts]);
    return { ...details, capturedGame: details.capturedGame || last.guessedGame, moments, edit: joinEdit(parts, info), thumb };
  }

  /**
   * Writes the joined file. Each stream is copied to a file of its own first, so that each one stops
   * at its own packet: the concat demuxer ends a file for every stream as soon as one passes the end.
   */
  async writeJoined(chain, { work, out, format, signal }) {
    const extension = EXTENSIONS[format];
    const streams = chain[0].file.streams;
    const partOf = (k, s) => path.join(work, `${k}-${s}${extension}`);
    for (const [k, { clip, file }] of chain.entries()) {
      await ffmpeg(['-i', clip.path, ...file.streams.flatMap((stream, s) => [
        '-map', `0:${stream.index}`, '-c', 'copy', '-f', format, partOf(k, s),
      ])], { signal, low: true });
    }
    // Read back: each copy must hold the packets that were compared, and gives the times the
    // demuxer will see.
    const copies = [];
    for (const [k, { file }] of chain.entries()) {
      copies.push([]);
      for (const [s, stream] of file.streams.entries()) {
        const [copy] = (await this.read(partOf(k, s), { signal, low: true })).streams;
        if (copy?.packets.length !== stream.packets.length || sameRun(copy, 0, stream, 0, stream.packets.length) === null) {
          throw new Error(t('dup.copyFailed'));
        }
        copies[k].push(copy);
      }
    }
    const junctions = chain.slice(1).map((next, k) => junction(chain[k].file, next.file));

    const args = [];
    for (const [s, stream] of streams.entries()) {
      // Each part until the packet where the next one starts, placed so that the next one starts at
      // the very time of that packet.
      const lines = ['ffconcat version 1.0'];
      for (const k of chain.keys()) {
        lines.push(`file '${path.basename(partOf(k, s))}'`);
        if (k === chain.length - 1) continue;
        const copy = copies[k][s];
        const next = copies[k + 1][s];
        const at = copy.packets[junctions[k][s].index];
        const length = at.pts * copy.timeBase - copy.start - (next.packets[0].pts * next.timeBase - next.start);
        lines.push(`duration ${micro(length)}`, `outpoint ${Math.floor(at.dts * copy.timeBase * 1e6)}us`);
      }
      const list = path.join(work, `${s}.ffconcat`);
      await fs.writeFile(list, `${lines.join('\n')}\n`);
      // The demuxer starts each stream at zero. Moved back, the streams keep the timing they had.
      const [first, original] = [copies[0][s], stream];
      const offset = first.start + original.packets[0].pts * original.timeBase - first.packets[0].pts * first.timeBase;
      args.push('-itsoffset', micro(offset), '-f', 'concat', '-safe', '0', '-auto_convert', '0', '-i', list);
    }
    // Each stream is an input of its own, and ffmpeg would start each input at zero: the sound,
    // which starts a frame before the picture, would move.
    await ffmpeg([
      '-copyts', ...args, ...streams.flatMap((_, s) => ['-map', `${s}:0`]), '-c', 'copy',
      ...trackNames(chain.at(-1).clip.audio), ...containerArgs(format), '-y', out,
    ], { signal, low: true });

    // Every packet of every part, in order, each part moved in one piece, the streams together.
    const got = await this.read(out, { signal, low: true });
    if (got.streams.length !== streams.length) throw new Error(t('dup.copyFailed'));
    let base = null;
    for (const s of streams.keys()) {
      let at = 0;
      let expected = null;
      for (const [k, { file }] of chain.entries()) {
        const original = file.streams[s];
        const keep = k < chain.length - 1 ? junctions[k][s].index : original.packets.length;
        const offset = sameRun(got.streams[s], at, original, 0, keep);
        const wrong = offset === null
          || (expected !== null && Math.abs(offset - expected) > TIME_TOLERANCE)
          || (k === 0 && base !== null && Math.abs(offset - base) > TIME_TOLERANCE);
        if (wrong) throw new Error(t('dup.copyFailed'));
        if (k === 0) base ??= offset;
        if (k < chain.length - 1) {
          const next = chain[k + 1].file.streams[s];
          expected = offset + original.packets[keep].pts * original.timeBase - next.packets[0].pts * next.timeBase;
        }
        at += keep;
      }
      if (at !== got.streams[s].packets.length) throw new Error(t('dup.copyFailed'));
    }
  }
}

module.exports = { Duplicates, candidatePairs, groupsOf, usable, MAX_LENGTH };
