// A log file in the app data. The installed app has no console, so its errors and crashes would
// otherwise leave no trace at all.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const NAME = 'clipshelf.log';
const OLD_NAME = 'clipshelf.old.log';
// Past this size the file becomes the old log and a new one starts, so the two never pass 4 MB.
const MAX_BYTES = 2 * 1024 * 1024;

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

const text = (part) => (typeof part === 'string' ? part : util.inspect(part, { depth: 4, breakLength: Infinity }));

class Log {
  constructor(dir, { maxBytes = MAX_BYTES } = {}) {
    this.file = path.join(dir, NAME);
    this.old = path.join(dir, OLD_NAME);
    this.maxBytes = maxBytes;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Writing fails later and is ignored there.
    }
    this.size = sizeOf(this.file);
  }

  /** Written at once, so that the line is on disk even if the process dies right after. */
  write(level, ...parts) {
    // Lines after the first are indented, so that a stack trace reads as one entry.
    const body = parts.map(text).join(' ').replace(/\r?\n/g, '\n    ');
    const line = `${new Date().toISOString()} ${level} ${body}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
    } catch {
      // A log that cannot be written must never break the app.
    }
  }

  rotate() {
    fs.rmSync(this.old, { force: true });
    fs.renameSync(this.file, this.old);
    this.size = 0;
  }

  /** Errors and warnings printed anywhere in the main process also go to the file. */
  captureConsole(target = console) {
    for (const [method, level] of [['error', 'ERROR'], ['warn', 'WARN']]) {
      const print = target[method].bind(target);
      target[method] = (...parts) => {
        this.write(level, ...parts);
        print(...parts);
      };
    }
  }

  /**
   * Crashes of the main process. The monitor only watches: Electron still shows its own dialog.
   * Electron keeps running after an unhandled rejection, and so does this listener.
   */
  captureCrashes(target = process) {
    target.on('uncaughtExceptionMonitor', (error, origin) => this.write('FATAL', `${origin}:`, error));
    target.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
  }
}

module.exports = { Log, NAME, OLD_NAME, MAX_BYTES };
