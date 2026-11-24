const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readTrackNames } = require('./trackNames');
const { t } = require('./i18n');

const children = new Set();

function binary(name) {
  return __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'bin', `${name}.exe`)
    : path.join(__dirname, '../../node_modules/ffmpeg-ffprobe-static', `${name}.exe`);
}

function run(name, args, { onData, onErrors, signal, cwd, low = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(name), args, { windowsHide: true, signal, cwd });
    children.add(child);
    const output = [];
    let errors = '';
    let failure = null;
    child.stdout.on('data', (data) => (onData ? onData(data) : output.push(data)));
    child.stderr.on('data', (data) => {
      errors = (errors + data).slice(-3000);
      onErrors?.(data);
    });
    child.on('error', (error) => {
      failure = error;
      if (child.pid) return; // Once stopped, it holds its files until it closes.
      children.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      children.delete(child);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(errors.trim() || `${name} exited with code ${code}`));
    });
    if (low && child.pid) {
      // Background work must not cost frames in a running game. 'idle' only takes what nobody uses.
      const { PRIORITY_LOW, PRIORITY_BELOW_NORMAL } = os.constants.priority;
      try {
        os.setPriority(child.pid, low === 'idle' ? PRIORITY_LOW : PRIORITY_BELOW_NORMAL);
      } catch {
        // The process may already have exited.
      }
    }
  });
}

const ffmpeg = (args, options) =>
  run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], options);

const ffprobe = (args, options) => run('ffprobe', ['-v', 'error', ...args], options);

async function probe(file) {
  const raw = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  const { streams = [], format = {} } = JSON.parse(raw);
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error(t('probe.noVideo'));

  const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
  const names = await readTrackNames(file);
  const rotated = video.side_data_list?.some((d) => Math.abs(d.rotation) === 90);
  return {
    duration: Number(format.duration) || Number(video.duration) || 0,
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    fps: num && den ? num / den : 30,
    codec: video.codec_name,
    pixels: video.pix_fmt,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({
      codec: s.codec_name,
      // For MP4 and MOV, the stream id is the track id.
      name: names.get(Number(s.id)) || s.tags?.title || s.tags?.handler_name || '',
    })),
  };
}

// Repeated timestamps, which some captures have, only bother the muxer that throws the frames
// away. They are not damage.
const MUXER_NOTE = /^\[null @/;

class Damaged extends Error {}

/**
 * Decodes every picture and every sound of a file, which reading its header (`probe`) cannot do.
 * A bit flipped in memory shows up here as a decoding error in about 9 cases out of 10.
 *
 * The file is written to the disk first, so the check reads what the disk holds: Windows writes
 * the very bytes it keeps in memory, and a bit that flips in memory later can only raise a false
 * alarm. Throws `Damaged` when the decoder meets damaged data.
 */
async function checkDecodes(file, { signal, low = true, duration = 0, onProgress = () => {} } = {}) {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  let log = ''; // Split into lines at the end: a line can arrive in two chunks.
  let failure = null;
  try {
    await run('ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
      '-xerror', '-err_detect', 'explode', '-i', file, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-',
    ], {
      signal,
      low,
      onData: (data) => {
        const time = String(data).match(/out_time_us=(\d+)/);
        if (time && duration > 0) onProgress(Math.min(1, Number(time[1]) / 1e6 / duration));
      },
      onErrors: (data) => {
        if (log.length < 100000) log += data;
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    failure = error.message;
  }
  const problems = log.split(/\r?\n/).filter((line) => line.trim() && !MUXER_NOTE.test(line));
  if (failure && !problems.length) problems.push(failure);
  if (problems.length) {
    console.error(`Damaged ${file}:`, problems.slice(0, 5).join(' | '));
    throw new Damaged(problems[0]);
  }
  onProgress(1);
}

/** Returns a function that runs at most `size` tasks at the same time. */
function limiter(size) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= size || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    next();
  });
}

function killAll() {
  for (const child of children) child.kill();
}

module.exports = { ffmpeg, ffprobe, probe, checkDecodes, Damaged, limiter, killAll };
