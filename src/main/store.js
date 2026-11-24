// Atomic JSON file with a backup of the previous version, and optionally one copy per day.
const fs = require('node:fs');
const path = require('node:path');

/** The local date, so that a day is the user's day and not the UTC one. */
function dayOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

class Store {
  /**
   * With `backups`, the file also keeps that many daily copies in a `backups` folder beside it.
   * The `.bak` only holds the version before the last save, which a bad save replaces within a second.
   */
  constructor(file, defaults = {}, { backups = 0, now = () => new Date() } = {}) {
    this.file = file;
    this.timer = null;
    this.data = { ...defaults };
    this.backups = backups;
    this.now = now;
    this.dir = path.join(path.dirname(file), 'backups');
    this.prefix = `${path.parse(file).name}-`;
    // The text of the last version known to be whole: the one read here, then each one written.
    this.lastText = null;
    for (const candidate of [file, `${file}.bak`, ...this.dailyCopies()]) {
      try {
        const text = fs.readFileSync(candidate, 'utf8');
        this.data = { ...defaults, ...JSON.parse(text) };
        this.lastText = text;
        if (candidate !== file) console.error(`Read ${candidate} instead of ${file}.`);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') console.error(`Cannot read ${candidate}:`, error.message);
      }
    }
  }

  /** The daily copies, newest first. */
  dailyCopies() {
    if (!this.backups) return [];
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(this.prefix) && /-\d{4}-\d\d-\d\d\.json$/.test(name))
      .sort().reverse().map((name) => path.join(this.dir, name));
  }

  /**
   * The copy of a day holds the version from before its first save, so a day that went wrong can
   * be undone whole. The newest copies are kept rather than the last days, so that weeks without
   * using the app do not remove them all.
   */
  backUp() {
    if (!this.backups || this.lastText === null) return;
    const target = path.join(this.dir, `${this.prefix}${dayOf(this.now())}.json`);
    if (fs.existsSync(target)) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${target}.tmp`, this.lastText);
      fs.renameSync(`${target}.tmp`, target);
      for (const old of this.dailyCopies().slice(this.backups)) fs.rmSync(old, { force: true });
    } catch (error) {
      console.error(`Cannot back up ${this.file}:`, error.message);
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.backUp();
    try {
      const temp = `${this.file}.tmp`;
      const text = JSON.stringify(this.data);
      fs.writeFileSync(temp, text);
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(temp, this.file);
      this.lastText = text;
    } catch (error) {
      console.error(`Cannot save ${this.file}:`, error.message);
      this.save();
    }
  }
}

module.exports = { Store, dayOf };
