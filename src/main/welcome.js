// The welcome screen shows at a start while its file is missing from the app data. Deleting the
// file shows it again at the next start: the user asked for this to see it when they want.
const fs = require('node:fs');
const path = require('node:path');
const { recordingFolders } = require('./obsLogs');

const FILE = 'welcome-done.txt';

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Whether one of the clip folders holds `dir`: clips in subfolders are read too. */
function covers(folders, dir) {
  const target = path.resolve(dir).toLowerCase();
  return folders.some((folder) => {
    const root = path.resolve(folder).toLowerCase();
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

/**
 * Where OBS records, read from its profile and never changed, and whether ClipShelf reads there.
 * `installed` is false when OBS has no profile on this PC.
 */
function obsState(obsDir, folders) {
  const installed = fs.existsSync(path.join(obsDir, 'basic', 'profiles'));
  return {
    installed,
    folders: recordingFolders(obsDir).map((dir) => ({ path: dir, exists: fs.existsSync(dir), covered: covers(folders, dir) })),
  };
}

class Welcome {
  constructor(dataDir) {
    this.file = path.join(dataDir, FILE);
    // Read once: a file deleted while the app runs shows the screen at the next start, as it says.
    this.needed = !fs.existsSync(this.file);
  }

  /** `text` tells whoever opens the file what it is for, in the language of the app. */
  done(text) {
    fs.writeFileSync(this.file, `${text}\r\n`);
    this.needed = false;
  }
}

module.exports = { Welcome, obsState, covers, same, FILE };
