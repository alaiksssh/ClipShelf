// shelf://app/ serves the UI and the clips, by id only: the page can never request an arbitrary path.
const fs = require('node:fs/promises');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv', '.ts': 'video/mp2t',
};
const CHUNK = 1024 * 1024;

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return [Math.max(0, size - Number(match[2])), size - 1];
  return [Number(match[1]), match[2] ? Math.min(Number(match[2]), size - 1) : size - 1];
}

async function serveFile(file, rangeHeader) {
  const { size } = await fs.stat(file);
  const range = parseRange(rangeHeader, size);
  if (range && range[0] > range[1]) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const [start, end] = range || [0, size - 1];
  let position = start;

  const body = new ReadableStream({
    async pull(controller) {
      if (position > end) {
        controller.close();
        return;
      }
      // Opened per chunk, so a paused player never locks a file against rename or delete.
      const handle = await fs.open(file, 'r');
      try {
        const length = Math.min(CHUNK, end - position + 1);
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, position);
        position += bytesRead;
        if (bytesRead) controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        else controller.close();
      } catch (error) {
        // The player cancels streams on every seek; enqueue then throws, which is expected.
        if (error.code !== 'ERR_INVALID_STATE') throw error;
      } finally {
        await handle.close();
      }
    },
  });

  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function createHandler({ library, derived, icons }) {
  const source = path.join(__dirname, '..');
  const routes = {
    media: (clip) => clip.path,
    thumb: (clip) => derived.thumb(clip, library.thumbOf(clip)),
    strip: (clip, index) => derived.strip(clip, index),
    track: (clip, index) => derived.track(clip, index),
    proxy: (clip) => derived.proxy(clip),
  };

  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response(null, { status: 404 });
      const [kind, id, index] = url.pathname.slice(1).split('/');

      let file;
      if (kind === 'logo') {
        file = icons?.fileOf(decodeURIComponent(id || ''));
        if (!file) return new Response(null, { status: 404 });
      } else if (Object.hasOwn(routes, kind)) {
        const clip = library.get(id);
        if (kind !== 'media' && (!clip.key || clip.broken)) return new Response(null, { status: 404 });
        file = await routes[kind](clip, Number(index) || 0);
      } else {
        file = path.join(source, decodeURIComponent(url.pathname === '/' ? '/ui/index.html' : url.pathname));
        const allowed = ['ui', 'shared'].some((dir) => file.startsWith(path.join(source, dir) + path.sep));
        if (!allowed) return new Response(null, { status: 404 });
      }
      return await serveFile(file, request.headers.get('range'));
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

module.exports = { createHandler, parseRange };
