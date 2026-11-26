// Updates of ClipShelf itself, from the releases of the public GitHub repository named in
// package.json (build.publish). The app looks at start and every few hours, downloads a newer version
// in the background, and installs it when it quits, or at once when the user asks for it. Asked while
// the download still runs, the install waits for its end, then ClipShelf closes by itself.
// Either way the installer shows its progress, so that nobody opens the old version while files are
// replaced; after a quit it does not open ClipShelf again (package.json sets nsis.runAfterFinish to
// false), and after "Redémarrer maintenant" it does (--force-run).
// It stays off when the app runs from the sources or for a check (CLIPSHELF_DATA, CLIPSHELF_UPDATES=off).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIRST_CHECK = 20e3; // Milliseconds after the start, so that the start stays fast.
const EVERY = 4 * 3600e3;

/** Whether this run may look for updates. */
function updatesEnabled({ packaged, env }) {
  return packaged && env.CLIPSHELF_UPDATES !== 'off' && !env.CLIPSHELF_DATA;
}

/**
 * Where electron-updater keeps what it downloaded: %LOCALAPPDATA% and the folder named in the
 * app-update.yml that electron-builder writes next to app.asar.
 */
function updaterFolder(resources = process.resourcesPath) {
  let name = 'clipshelf-updater';
  try {
    const yml = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
    name = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+)/m.exec(yml)?.[1].trim() || name;
  } catch {
    // An app built without updates has no such file; the usual name is enough.
  }
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), name);
}

/**
 * Whether the installer of a downloaded version is running. Windows forbids writing to a running
 * program, so its file cannot be opened for writing. Opened during the install, ClipShelf would lock
 * the files the installer replaces, then be closed by it; it quits at once instead. Only asked by the
 * single instance: while another ClipShelf runs, a download may hold a file of that folder.
 */
function updateInstalling(folder = updaterFolder()) {
  const pending = path.join(folder, 'pending');
  let names;
  try {
    names = fs.readdirSync(pending);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!/\.exe$/i.test(name) || name.startsWith('temp-')) return false;
    try {
      fs.closeSync(fs.openSync(path.join(pending, name), 'r+'));
      return false;
    } catch (error) {
      return error.code === 'EBUSY';
    }
  });
}

/** Rounds a share of the download to whole percents, so that the page is not told every few bytes. */
function downloadShare(percent) {
  return Math.min(100, Math.max(0, Math.floor(Number(percent) || 0))) / 100;
}

class Updater {
  /**
   * `onChange` is told when an update is found, ready, waited for or lost; `onProgress` gets the share
   * of its download (0 to 1); `busy` says whether a job would be cut short by a restart.
   */
  constructor({ app, onChange, onProgress = () => {}, busy }) {
    Object.assign(this, { app, onChange, onProgress, busy });
    this.found = null; // The newer version being downloaded.
    this.ready = null; // The version waiting to be installed.
    this.notes = null; // Its release notes, as GitHub gives them: the page shows its news.
    this.share = 0; // How much of it has been downloaded.
    this.wanted = false; // Install asked while it downloads.
    this.failed = false; // Its download failed; the next check tries again.
    this.lastError = '';
    // The events of electron-updater, apart so that a test can send them.
    this.handlers = {
      'update-available': ({ version, releaseNotes }) => {
        this.found = version;
        this.notes = releaseNotes ?? null;
        this.share = 0;
        this.failed = false;
        this.onChange();
      },
      'download-progress': ({ percent }) => {
        const share = downloadShare(percent);
        if (share === this.share) return;
        this.share = share;
        this.onProgress(share);
      },
      'update-downloaded': ({ version, releaseNotes }) => {
        this.ready = version;
        this.notes = releaseNotes ?? this.notes;
        this.found = null;
        this.share = 1;
        const wanted = this.wanted;
        this.wanted = false;
        this.onChange();
        // Asked during the download: it goes in now, unless an export started meanwhile.
        if (wanted) this.install();
      },
      error: (error) => {
        this.warn(error);
        if (!this.found || this.ready) return;
        // A download cut short (offline, GitHub down): the page says so, and the next check tries again.
        this.failed = true;
        this.wanted = false;
        this.onChange();
      },
    };
  }

  /** What the page shows of it, or null when there is no newer version. */
  status() {
    const version = this.ready || this.found;
    if (!version) return null;
    return { version, ready: Boolean(this.ready), share: this.ready ? 1 : this.share, waiting: this.wanted, failed: this.failed };
  }

  start() {
    if (!updatesEnabled({ packaged: this.app.isPackaged, env: process.env })) return;
    // Loaded only here: a run from the sources never needs it.
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    autoUpdater.autoDownload = true;
    // Its own install at quit is silent: nothing shows for a minute, and a ClipShelf opened meanwhile
    // is the old one, closed by the installer. Ours shows the progress and does not reopen the app.
    autoUpdater.autoInstallOnAppQuit = false;
    this.app.once('quit', (_, exitCode) => {
      if (this.ready && !this.installing && exitCode === 0) this.updater.install(false, false);
    });
    // Its info lines would fill the log at every check; problems still go to it, once each.
    autoUpdater.logger = { info() {}, debug() {}, warn: (text) => this.warn(text), error: (text) => this.warn(text) };
    for (const [name, handler] of Object.entries(this.handlers)) autoUpdater.on(name, handler);
    setTimeout(() => this.check(), FIRST_CHECK).unref();
    setInterval(() => this.check(), EVERY).unref();
  }

  check() {
    if (this.ready || (this.found && !this.failed)) return; // Downloaded (it goes in at the next quit), or downloading.
    this.updater.checkForUpdates().catch((error) => this.warn(error));
  }

  /** Being offline is common: the same problem is written to the log once, not every 4 hours. */
  warn(problem) {
    const text = String(problem?.message || problem).split('\n')[0];
    if (text === this.lastError) return;
    this.lastError = text;
    console.warn('Update:', text);
  }

  /**
   * Quits and installs the downloaded version, then starts it again: true. During its download, the
   * install waits for the end ('waiting'), or no longer does with `want` false. False when there is
   * nothing to install, or when a job runs.
   */
  install(want = true) {
    if (!this.ready && this.found && !this.failed) {
      this.wanted = want !== false;
      this.onChange();
      return this.wanted ? 'waiting' : false;
    }
    if (!want || !this.ready || this.busy()) return false;
    this.installing = true;
    // Not silent, so the progress shows; autoRunAppAfterInstall (true) adds --force-run.
    this.updater.autoRunAppAfterInstall = true;
    this.updater.quitAndInstall(false, true);
    return true;
  }
}

module.exports = { Updater, updatesEnabled, updaterFolder, updateInstalling, downloadShare };
