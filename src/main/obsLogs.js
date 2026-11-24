// OBS does not write the game into its files, but its logs tell which process the game capture
// hooked, when, and the path of every recording and replay. Reading them avoids any guess.
const fs = require('node:fs/promises');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { gameFromProcess } = require('./games');

const LOG_NAME = /^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-(\d\d)\.txt$/;
const LINE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}): (.*)$/;
const HOOK = /^\[game-capture: '.*'\] attempting to hook (?:fullscreen )?process: (.+)$/;
const CAPTURED = /^\[game-capture: '.*'\] .*capture successful$/;
const RELEASED = /^\[game-capture: '.*'\] (?:capture stopped|capture window no longer exists)/;
const RECORDING = /^\[.*\] Writing (?:Hybrid \S+ )?file '(.+)'\.*$/;
const REPLAY = /^\[.*\] Wrote replay buffer to '(.+)'$/;
const HALF_DAY = 12 * 3600 * 1000;

const keyOf = (file) => path.resolve(file).toLowerCase();

/** `name` is the log file name, which holds the day the session started. */
function parseLog(name, text) {
  const session = { captures: [], files: new Map() };
  const started = name.match(LOG_NAME);
  if (!started) return session;

  const [year, month, day] = started.slice(1, 4).map(Number);
  let dayOffset = 0;
  let previous = new Date(year, month - 1, day, ...started.slice(4).map(Number)).getTime();
  const titles = new Map();
  let executable = '';
  let hooked = '';
  let open = null;

  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.match(LINE);
    if (!parts) continue;
    const [hour, minute, second, ms] = parts.slice(1, 5).map(Number);
    let time = new Date(year, month - 1, day + dayOffset, hour, minute, second, ms).getTime();
    if (time < previous - HALF_DAY) {
      dayOffset += 1; // Past midnight.
      time = new Date(year, month - 1, day + dayOffset, hour, minute, second, ms).getTime();
    }
    previous = time;

    const line = parts[5];
    let match;
    if ((match = line.match(/^\s+executable: (.*)$/))) {
      executable = match[1].trim();
    } else if ((match = line.match(/^\s+title: (.*)$/))) {
      if (executable && match[1].trim()) titles.set(executable, match[1].trim());
    } else if ((match = line.match(HOOK))) {
      hooked = match[1].trim();
    } else if (CAPTURED.test(line)) {
      // Not tracked per source: renaming a source changes its name in the middle of a capture.
      if (open?.executable === hooked) continue;
      if (open) open.end = time;
      open = { executable: hooked, start: time, end: Infinity };
      session.captures.push(open);
    } else if (RELEASED.test(line) || line.startsWith('==== Shutting down')) {
      if (open) open.end = time;
      open = null;
    } else if ((match = line.match(RECORDING))) {
      session.files.set(keyOf(match[1]), { start: time });
    } else if ((match = line.match(REPLAY))) {
      session.files.set(keyOf(match[1]), { end: time });
    }
  }

  // Titles often appear after the hook, so they are attached last.
  for (const capture of session.captures) capture.title = titles.get(capture.executable) || '';
  return session;
}

const nameOfCapture = (capture) => gameFromProcess(capture.executable, capture.title);

/**
 * The game captured for the longest part of a file, and the process it ran as, or null when the logs
 * don't know. Names are found now, not when the log is read: games added later count.
 */
function captureInSession({ captures, files }, file, duration, nameOf = nameOfCapture) {
  const written = files.get(keyOf(file));
  if (!written) return null;
  // A recording is logged when it starts, a replay when it is saved.
  const start = written.start ?? written.end - duration * 1000;
  const end = written.end ?? written.start + duration * 1000;

  const totals = new Map();
  for (const capture of captures) {
    const overlap = Math.min(end, capture.end) - Math.max(start, capture.start);
    const game = overlap > 0 && nameOf(capture);
    if (!game) continue;
    const total = totals.get(game) || { game, time: 0, programs: new Map() };
    total.time += overlap;
    total.programs.set(capture.executable, (total.programs.get(capture.executable) || 0) + overlap);
    totals.set(game, total);
  }
  const best = [...totals.values()].sort((a, b) => b.time - a.time)[0];
  return best ? { game: best.game, executable: [...best.programs].sort((a, b) => b[1] - a[1])[0][0] } : null;
}

function gameInSession(session, file, duration, nameOf) {
  return captureInSession(session, file, duration, nameOf)?.game || '';
}

class ObsLogs {
  /** `added` holds the games the user added, which name their programs first. */
  constructor(dir, added = null) {
    this.dir = dir;
    this.added = added;
    this.sessions = new Map();
  }

  /** Reads new and grown logs only. */
  async refresh() {
    const names = await fs.readdir(this.dir).catch(() => []); // No OBS: nothing to know.
    const next = new Map();
    for (const name of names.filter((n) => LOG_NAME.test(n))) {
      try {
        const file = path.join(this.dir, name);
        const { size } = await fs.stat(file);
        const known = this.sessions.get(name);
        next.set(name, known?.size === size
          ? known
          : { size, ...parseLog(name, await fs.readFile(file, 'utf8')) });
      } catch (error) {
        console.error(`Cannot read OBS log ${name}:`, error.message);
      }
    }
    this.sessions = next;
  }

  /** { game, executable } of a file, or null. */
  captureFor(file, duration) {
    const nameOf = (capture) => gameFromProcess(capture.executable, capture.title, this.added);
    for (const session of this.sessions.values()) {
      const found = captureInSession(session, file, duration, nameOf);
      if (found) return found;
    }
    return null;
  }
}

const readIni = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The value of a key of an .ini file, or ''. */
const iniValue = (text, key) => text.split(/\r?\n/).find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() || '';

/**
 * The folders OBS records into, from its settings in `obsDir`: those of the profile in use, or of
 * every profile when OBS does not say which. Recordings and replays go to RecFilePath in advanced
 * mode, and to FilePath in simple mode; the other path is left over from the other mode.
 */
function recordingFolders(obsDir) {
  const profiles = path.join(obsDir, 'basic', 'profiles');
  let names;
  try {
    names = readdirSync(profiles);
  } catch {
    return []; // OBS is not installed.
  }
  // OBS 31 keeps the profile in use in user.ini, older releases in global.ini.
  const current = ['user.ini', 'global.ini'].map((file) => iniValue(readIni(path.join(obsDir, file)), 'ProfileDir'))
    .find((name) => names.includes(name));
  const folders = [];
  for (const name of current ? [current] : names) {
    const ini = readIni(path.join(profiles, name, 'basic.ini'));
    const value = iniValue(ini, iniValue(ini, 'Mode') === 'Advanced' ? 'RecFilePath' : 'FilePath');
    // OBS doubles the backslashes of the paths it writes.
    if (value) folders.push(path.resolve(value.replaceAll('\\\\', '\\')));
  }
  return [...new Map(folders.map((dir) => [dir.toLowerCase(), dir])).values()];
}

module.exports = { ObsLogs, parseLog, gameInSession, captureInSession, recordingFolders };
