// Finds kills and deaths in the Valorant clips, one clip at a time and behind everything else:
// the game is often running while ClipShelf is open.
const { ffmpeg } = require('./ffmpeg');
const { KillFeed, FRAME_BYTES, FILTER, FPS } = require('./killFeed');

const VERSION = 2; // 2: rounds. A clip read by an older version is read again.
const GAME = 'valorant';
const THREADS = 2;

async function readKillFeed(clip, { signal } = {}) {
  const feed = new KillFeed();
  const frame = Buffer.alloc(FRAME_BYTES);
  let filled = 0;
  let count = 0;

  const onData = (data) => {
    let offset = 0;
    while (offset < data.length) {
      const copied = data.copy(frame, filled, offset);
      filled += copied;
      offset += copied;
      if (filled < FRAME_BYTES) continue;
      feed.push(frame, count / FPS);
      count += 1;
      filled = 0;
    }
  };

  await ffmpeg([
    '-threads', String(THREADS), '-i', clip.path, '-filter_complex_threads', '1', '-filter_complex', FILTER,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { onData, signal, low: 'idle' });

  if (!count) throw new Error('No picture could be read.');
  return feed.result();
}

class Detector {
  constructor({ library, enabled, read = readKillFeed }) {
    Object.assign(this, { library, enabled, read });
    this.failed = new Set();
    this.wanted = null;
    this.current = null;
    this.holds = 0;
    this.stopped = false;
    library.on('change', () => this.pump());
  }

  queue() {
    const { meta } = this.library;
    return [...this.library.clips.values()].filter((clip) => {
      if (clip.busy || clip.broken || !clip.key || this.failed.has(clip.key)) return false;
      const saved = meta.data[clip.key] || {};
      if ((saved.moments?.detected || 0) >= VERSION) return false;
      return String(saved.game ?? clip.guessedGame).toLowerCase() === GAME;
    });
  }

  status() {
    return { id: this.current?.id ?? null, left: this.enabled() ? this.queue().length : 0 };
  }

  /** The clip that is on screen goes first. */
  prefer(id) {
    this.wanted = id;
    this.pump();
  }

  retry(id) {
    this.failed.delete(this.library.get(id).key);
    this.prefer(id);
  }

  pump() {
    if (this.stopped || this.holds || this.current || !this.enabled()) return;
    const queue = this.queue();
    if (!queue.length) return;
    const clip = queue.find((c) => c.id === this.wanted) || queue.sort((a, b) => b.date - a.date)[0];
    const job = { id: clip.id, key: clip.key, controller: new AbortController() };
    this.current = job;
    job.done = this.process(clip, job).finally(() => {
      this.current = null;
      this.pump();
    });
  }

  async process(clip, { key, controller }) {
    try {
      const result = await this.read(clip, { signal: controller.signal });
      if (!controller.signal.aborted) await this.library.setDetected(key, { version: VERSION, ...result });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.failed.add(key);
      console.error(`Cannot read the kill feed of ${clip.name}:`, error.message);
      this.library.emit('change');
    }
  }

  interrupt() {
    this.current?.controller.abort();
  }

  /** Nothing may be reading a file that gets replaced, renamed or binned. */
  async withFilesFree(task) {
    this.holds += 1;
    try {
      const { current } = this;
      this.interrupt();
      await current?.done;
      return await task();
    } finally {
      this.holds -= 1;
      this.pump();
    }
  }

  stop() {
    this.stopped = true;
    this.interrupt();
  }
}

module.exports = { Detector, readKillFeed, VERSION };
