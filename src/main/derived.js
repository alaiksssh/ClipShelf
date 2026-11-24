// Everything generated from clips (thumbnails, extracted tracks, proxies) lives in the app cache.
const fs = require('node:fs/promises');
const path = require('node:path');
const { ffmpeg, limiter } = require('./ffmpeg');
const { analyse } = require('./audio');
const { t } = require('./i18n');

/** More pictures for long recordings, so that a zoomed timeline stays useful. */
const filmFrames = (duration) => Math.round(Math.min(80, Math.max(14, duration / 3)));
const END_MARGIN = 0.25; // Seconds kept before the end of a clip when taking a picture.

class Derived {
  constructor(dir) {
    this.dir = dir;
    this.pending = new Map();
    this.images = limiter(4);
  }

  /** Everything here can be regenerated, so old files are dropped to keep the cache small. */
  async prune(days = 30) {
    const oldest = Date.now() - days * 864e5;
    for (const name of await fs.readdir(this.dir).catch(() => [])) {
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < oldest) await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  async cached(name, make) {
    const target = path.join(this.dir, name);
    if (this.pending.has(target)) return this.pending.get(target);
    const job = (async () => {
      if (await fs.stat(target).then((s) => s.size > 0, () => false)) return target;
      await fs.mkdir(this.dir, { recursive: true });
      const temp = path.join(this.dir, `tmp-${name}`);
      try {
        await make(temp);
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return target;
    })().finally(() => this.pending.delete(target));
    this.pending.set(target, job);
    return job;
  }

  frame(clip, time, width, name) {
    return this.cached(name, (out) => this.images(() => ffmpeg([
      '-ss', String(time), '-i', clip.path, '-an', '-frames:v', '1',
      '-vf', `scale=${width}:-2`, '-q:v', '4', '-update', '1', '-y', out,
    ], { low: true })));
  }

  /** `time` is the picture the user chose for the card, if any: each choice has a file of its own. */
  thumbOf(clip, time) {
    if (!Number.isFinite(time)) return { time: clip.duration * 0.4, name: `${clip.key}-thumb.jpg` };
    const at = Math.min(Math.max(0, time), Math.max(0, clip.duration - END_MARGIN));
    return { time: at, name: `${clip.key}-thumb-${Math.round(at * 1000)}.jpg` };
  }

  thumb(clip, chosen) {
    const { time, name } = this.thumbOf(clip, chosen);
    return this.frame(clip, time, 480, name);
  }

  strip(clip, index) {
    const count = filmFrames(clip.duration);
    const i = Math.min(count - 1, Math.max(0, Math.floor(index)));
    // Past the start of the last picture, ffmpeg writes nothing and says nothing: in a clip of a
    // second or two at a low frame rate, the last pictures of the strip would fall there.
    const time = Math.min((clip.duration * (i + 0.5)) / count, Math.max(0, clip.duration - END_MARGIN));
    return this.frame(clip, time, 192, `${clip.key}-film${count}-${i}.jpg`);
  }

  track(clip, index) {
    const stream = clip.audio[index];
    if (!stream) throw new Error(t('derived.noTrack'));
    const codec = stream.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
    return this.cached(`${clip.key}-track${index}.m4a`, (out) => ffmpeg([
      '-i', clip.path, '-map', `0:a:${index}`, '-vn', ...codec, '-movflags', '+faststart', '-y', out,
    ]));
  }

  proxy(clip) {
    return this.cached(`${clip.key}-proxy.mp4`, (out) => ffmpeg([
      '-i', clip.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=-2:'min(720,ih)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', '-y', out,
    ], { low: true }));
  }

  async analysis(clip) {
    const file = await this.cached(`${clip.key}-audio5.json`, async (out) => {
      await fs.writeFile(out, JSON.stringify(await analyse(clip.path, clip)));
    });
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
}

module.exports = { Derived, filmFrames };
