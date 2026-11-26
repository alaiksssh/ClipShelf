// Updates of ClipShelf itself, from the releases of the public GitHub repository named in
// package.json (build.publish). The app looks at start and every few hours, downloads a newer version
// in the background, and installs it when it quits, or at once when the user asks for it.
// It stays off when the app runs from the sources or for a check (CLIPSHELF_DATA, CLIPSHELF_UPDATES=off).

const FIRST_CHECK = 20e3; // Milliseconds after the start, so that the start stays fast.
const EVERY = 4 * 3600e3;

/** Whether this run may look for updates. */
function updatesEnabled({ packaged, env }) {
  return packaged && env.CLIPSHELF_UPDATES !== 'off' && !env.CLIPSHELF_DATA;
}

class Updater {
  /** `onChange` is told when an update is ready; `busy` says whether a job would be cut short by a restart. */
  constructor({ app, onChange, busy }) {
    Object.assign(this, { app, onChange, busy });
    this.ready = null; // The version waiting to be installed.
    this.notes = null; // Its release notes, as GitHub gives them: the page shows its news.
    this.lastError = '';
  }

  start() {
    if (!updatesEnabled({ packaged: this.app.isPackaged, env: process.env })) return;
    // Loaded only here: a run from the sources never needs it.
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Its info lines would fill the log at every check; problems still go to it, once each.
    autoUpdater.logger = { info() {}, debug() {}, warn: (text) => this.warn(text), error: (text) => this.warn(text) };
    autoUpdater.on('update-downloaded', ({ version, releaseNotes }) => {
      this.ready = version;
      this.notes = releaseNotes ?? null;
      this.onChange();
    });
    autoUpdater.on('error', (error) => this.warn(error));
    setTimeout(() => this.check(), FIRST_CHECK).unref();
    setInterval(() => this.check(), EVERY).unref();
  }

  check() {
    if (this.ready) return; // Already downloaded: it goes in at the next quit.
    this.updater.checkForUpdates().catch((error) => this.warn(error));
  }

  /** Being offline is common: the same problem is written to the log once, not every 4 hours. */
  warn(problem) {
    const text = String(problem?.message || problem).split('\n')[0];
    if (text === this.lastError) return;
    this.lastError = text;
    console.warn('Update:', text);
  }

  /** Quits and installs the downloaded version, then starts it again. False when there is none. */
  install() {
    if (!this.ready || this.busy()) return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }
}

module.exports = { Updater, updatesEnabled };
