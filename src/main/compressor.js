// Compressing clips to H.265, to get disk space back.
//
// Only the picture is encoded again. The sound is copied as it is and every track keeps its name,
// and frame times are kept, so moments and montages stay where they were. The new file takes the
// place of the clip in a single rename, and the original goes to the Recycle Bin under a readable
// name: the user can still get it back until the bin is emptied.
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { ffmpeg, probe, checkDecodes, Damaged } = require('./ffmpeg');
const { FORMATS, linkOrCopy, swap, checkUnchanged, keyOfFile } = require('./versions');
const { t } = require('./i18n');

const MODERN = new Set(['hevc', 'av1', 'vp9']);
const EIGHT_BITS = new Set(['yuv420p', 'yuvj420p', 'nv12']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac']);
const LENGTH_TOLERANCE = 0.5; // Seconds.
const MIN_SAVING = 0.15; // Below this, a new encode is not worth its loss: the original stays.
const ENCODE_SHARE = 0.8; // Of the progress of one clip. The rest is the check of the new file.

// Hardware first: several times faster than real time, and the processor stays free for the game.
// Quantizers measured on real clips: 42 to 52 % of the size, SSIM 0.977 to 0.985 against the original.
// The "balanced" preset of AMD: twice as fast as "quality", 4 % heavier, the same SSIM (1080p75).
const ENCODERS = [
  { name: 'hevc_amf', args: ['-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '25', '-qp_p', '27'] },
  { name: 'hevc_nvenc', args: ['-preset', 'p5', '-rc', 'constqp', '-qp', '27'] },
  { name: 'hevc_qsv', args: ['-preset', 'slower', '-global_quality', '27'], pixels: 'nv12' },
  { name: 'libx265', args: ['-preset', 'fast', '-crf', '26', '-x265-params', 'log-level=error'] },
];

class Skip extends Error {}

let working;

/** The encoders this machine can run, best first. */
function available() {
  working ??= (async () => {
    const found = [];
    for (const encoder of ENCODERS) {
      const ok = await ffmpeg([
        '-f', 'lavfi', '-i', 'color=s=640x360:r=30:d=0.2',
        '-c:v', encoder.name, '-pix_fmt', encoder.pixels || 'yuv420p', '-f', 'null', '-',
      ]).then(() => true, () => false);
      if (ok) found.push(encoder);
    }
    return found;
  })();
  return working;
}

/** A free name that the Recycle Bin will show. */
function asideName(clip) {
  const dir = path.dirname(clip.path);
  const extension = path.extname(clip.path);
  for (let n = 1; ; n += 1) {
    const file = path.join(dir, `${clip.name} (${t('compress.beforeName')}${n > 1 ? ` ${n}` : ''})${extension}`);
    if (!existsSync(file)) return file;
  }
}

class Compressor {
  constructor({ library, trashItem }) {
    this.library = library;
    this.meta = library.meta;
    this.trashItem = trashItem;
  }

  async encode(clip, info, out, format, { signal, onProgress = () => {} }) {
    const audio = info.audio.flatMap((track, i) => {
      const copy = format === 'matroska' || MP4_AUDIO.has(track.codec);
      return [
        `-c:a:${i}`, ...(copy ? ['copy'] : ['aac', `-b:a:${i}`, '320k']),
        ...(track.name ? [`-metadata:s:a:${i}`, `title=${track.name}`, `-metadata:s:a:${i}`, `handler_name=${track.name}`] : []),
      ];
    });
    // A key frame every 2 seconds keeps seeking in the editor quick.
    const gop = String(Math.max(1, Math.round(info.fps * 2)));
    let last = null;
    for (const encoder of await available()) {
      try {
        await ffmpeg([
          '-progress', 'pipe:1', '-nostats', '-i', clip.path,
          '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
          '-c:v', encoder.name, ...encoder.args, '-pix_fmt', encoder.pixels || 'yuv420p', '-g', gop,
          '-fps_mode', 'passthrough',
          ...(format === 'matroska' ? [] : ['-tag:v', 'hvc1', '-movflags', '+faststart']),
          ...audio, '-f', format, '-y', out,
        ], {
          signal,
          low: 'idle',
          onData: (data) => {
            const time = String(data).match(/out_time_us=(\d+)/);
            if (time) onProgress(Math.min(1, Number(time[1]) / 1e6 / info.duration));
          },
        });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        last = error;
        console.error(`${encoder.name} failed, trying the next encoder:`, error.message);
      }
    }
    throw new Error(t('compress.failed', { reason: last?.message.split('\n').at(-1) || t('compress.noEncoder') }));
  }

  /** Resolves to { id, before, after, trashed, aside } or { skipped: reason }. */
  async compress(clip, job = {}) {
    try {
      return await this.run(clip, job);
    } catch (error) {
      if (error instanceof Skip) return { skipped: error.message };
      throw error;
    }
  }

  async run(clip, { signal, onProgress = () => {} }) {
    if (clip.busy || clip.broken || !clip.key) throw new Skip(t('compress.notNow'));
    await checkUnchanged(clip);
    const info = await probe(clip.path);
    if (MODERN.has(info.codec)) throw new Skip(t('compress.already'));
    if (!EIGHT_BITS.has(info.pixels)) throw new Skip(t('compress.tenBits'));

    const dir = path.dirname(clip.path);
    const format = FORMATS[path.extname(clip.path).toLowerCase()];
    const target = format ? clip.path : path.join(dir, `${clip.name}.mp4`);
    if (!format && existsSync(target)) throw new Skip(t('compress.nameTaken', { name: path.basename(target) }));

    // Next to the clip, so the result is moved and never copied from another disk.
    const out = path.join(dir, `.compress-${process.pid}-${Date.now()}.clipshelf-part`);
    let key = null;
    let before;
    let aside = null;
    let size;
    let result;
    try {
      await this.encode(clip, info, out, format || 'mp4', {
        signal, onProgress: (value) => onProgress(value * ENCODE_SHARE),
      });
      result = await probe(out);
      if (Math.abs(result.duration - info.duration) > LENGTH_TOLERANCE || result.audio.length !== info.audio.length
        || result.codec !== 'hevc') {
        throw new Error(t('job.incomplete'));
      }
      ({ size } = await fs.stat(out));
      if (size > clip.size * (1 - MIN_SAVING)) throw new Skip(t('compress.compact'));
      await checkDecodes(out, {
        signal,
        low: 'idle',
        duration: info.duration,
        onProgress: (value) => onProgress(ENCODE_SHARE + (1 - ENCODE_SHARE) * value, 'check'),
      }).catch((error) => {
        if (!(error instanceof Damaged)) throw error;
        throw new Error(t('compress.damaged'));
      });

      // Keeps its place in the library, yet differs from the original for the index.
      const { atime, mtime } = await fs.stat(clip.path);
      await fs.utimes(out, atime, new Date(mtime.getTime() + 10));
      key = await keyOfFile(out);
      before = this.meta.data[key];
      const from = this.meta.data[clip.key] || {};
      // Same frames at the same times: name, tags, moments and montage all still apply.
      this.meta.data[key] = { ...from, capturedGame: from.capturedGame || clip.guessedGame };
      this.meta.save();
      this.meta.flush(); // On disk before any file moves.

      signal?.throwIfAborted();
      await checkUnchanged(clip);
      aside = asideName(clip);
      await linkOrCopy(clip.path, aside);
      await swap(out, clip.path, target);
    } catch (error) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (aside && existsSync(clip.path)) await fs.rm(aside, { force: true }).catch(() => {});
      if (key) {
        if (before) this.meta.data[key] = before;
        else delete this.meta.data[key];
        this.meta.save();
      }
      throw error;
    }

    // Binned before the scan that adopts the new file, so the library never shows it.
    const trashed = await this.trashItem(aside).then(() => true, (error) => {
      console.error(`Cannot trash ${aside}:`, error.message);
      return false;
    });
    const id = await this.library.adopt(target, result, key);
    return { id, before: clip.size, after: size, trashed, aside: trashed ? null : aside };
  }
}

module.exports = { Compressor, available };
