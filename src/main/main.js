const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, shell, clipboard, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Log } = require('./log');
const { Store } = require('./store');
const { Library } = require('./library');
const { ObsLogs, recordingFolders } = require('./obsLogs');
const { Derived } = require('./derived');
const { createHandler } = require('./protocol');
const { exportClip, hasAmf } = require('./exporter');
const { Versions } = require('./versions');
const { Compressor } = require('./compressor');
const { Duplicates } = require('./duplicates');
const { killAll } = require('./ffmpeg');
const { Detector } = require('./detector');
const { GameIcons, IMAGES } = require('./gameIcons');
const { Organizer } = require('./organizer');
const { UserGames } = require('./userGames');
const { GameFolders } = require('./gameFolders');
const { Programs } = require('./programs');
const { installedGames, programsIn, mainProgram, plainName } = require('./launchers');
const clipboardFiles = require('./clipboardFiles');
const { DiscordFiles } = require('./discordFiles');
const { Welcome, obsState, same } = require('./welcome');
const { windowState, placeWindow } = require('./windowState');
const { Updater, updateInstalling } = require('./updater');
const i18n = require('./i18n');
const { LANGUAGES } = require('../shared/i18n.mjs');

const { t } = i18n;

const editModel = import('../shared/edit.mjs');
const gameList = import('../shared/gameList.mjs');

// CLIPSHELF_DATA and CLIPSHELF_VIDEOS isolate a test run from the real library.
app.setPath('userData', process.env.CLIPSHELF_DATA || path.join(app.getPath('appData'), 'ClipShelf'));
app.setAppUserModelId('local.clipshelf.app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'shelf', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

const TRASH_RETRIES = 12;
const TRASH_RETRY_DELAY = 500;
const ICON = path.join(__dirname, '../ui/icon.png');
const BACKUP_DAYS = 14;

let win;
let log;
let settings;
let meta;
let index;
let library;
let derived;
let versions;
let detector;
let icons;
let organizer;
let compressor;
let duplicates;
let userGames;
let gameFolders;
let discordFiles;
let installed = []; // The games of the launchers, as last shown in "Ajouter un jeu".
let programs;
let welcome;
let updater;
let freeDisks = []; // For the status bar: refreshFreeSpace().
let openId = null; // The clip open in the editor stays where it is.
let closed = { id: null, until: 0 }; // And a little longer: pictures of it may still be on their way.
const CLOSED_MS = 10 * 1000;
let scanned = false;
let shortcutsWindow = null;

// The bar of the window takes the colours of the theme. Keep in sync with themes.js.
const THEME_BARS = {
  periph: ['#0D0F14', '#8A93A6'], graphite: ['#1A1A1A', '#9A9A9A'], midnight: ['#0A0E1A', '#8B95B5'],
  oled: ['#000000', '#8A8A8F'], sakura: ['#120C12', '#A68FA5'], forest: ['#0B120E', '#8AA394'],
};
const themeBar = () => THEME_BARS[settings?.data.theme] || THEME_BARS.periph;
let exportJob = null;
let maximizedBefore = false;

const send = (channel, ...data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...data);
};

function setTaskbarProgress(value) {
  if (win && !win.isDestroyed()) win.setProgressBar(value);
}

/** The settings of OBS, only read. CLIPSHELF_OBS lets a check give an OBS of its own. */
function obsDir() {
  return process.env.CLIPSHELF_OBS || path.join(app.getPath('appData'), 'obs-studio');
}

/**
 * The clip folders of a first start: the one OBS records into, as set in OBS. Other folders, such as
 * Videos or Downloads, hold other videos. Without OBS settings, Videos\ClipShelf, made for it, which
 * the welcome screen offers to change.
 */
function defaultFolders(videos) {
  if (process.env.CLIPSHELF_VIDEOS) return [videos];
  const recorded = recordingFolders(obsDir()).filter((dir) => fs.existsSync(dir));
  if (recorded.length) return recorded;
  const own = path.join(videos, 'ClipShelf');
  try {
    fs.mkdirSync(own, { recursive: true });
  } catch (error) {
    console.error(`Cannot make ${own}:`, error.message);
  }
  return [own];
}

function state() {
  const found = duplicates.summary();
  // Each clip of a group knows it, for its card and its menu.
  const groupOf = new Map(found.groups.flatMap((group) => group.clips.map((member) => [member.id, { group, member }])));
  return {
    version: app.getVersion(),
    scanned,
    clips: library.list().map((clip) => {
      const known = groupOf.get(clip.id);
      return known ? { ...clip, duplicate: { shared: known.member.shared, others: known.group.ids.length - 1 } } : clip;
    }),
    duplicates: found,
    folders: settings.data.folders.map((dir) => ({ path: dir, online: fs.existsSync(dir), sorted: gameFolders.isOn(dir) })),
    games: userGames.list().map(({ name, source }) => ({ name, source })),
    exportDir: settings.data.exportDir,
    theme: settings.data.theme || 'periph',
    categories: organizer.categories(),
    tags: organizer.createdTags(),
    logos: icons.list(),
    detection: { on: detectionOn(), ...detector.status() },
    welcome: welcome.needed,
    news: settings.data.seenVersion === app.getVersion() ? null : app.getVersion(),
    disks: freeDisks,
    update: updater?.ready || null, // A newer version, downloaded and waiting.
    updateNotes: updater?.ready ? updater.notes : null,
  };
}

function detectionOn() {
  return settings.data.detectMoments !== false;
}

function publish() {
  send('changed', state());
}

const trusted = (event) => event.senderFrame?.url.startsWith('shelf://app/');

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { error: t('main.denied') };
    try {
      return { value: await fn(...args) };
    } catch (error) {
      return { error: error.message || String(error) };
    }
  });
}

/** A clip that was just opened may still be being read, and Windows then refuses to bin it. */
async function trashWhenFree(file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await shell.trashItem(file); // Recycle Bin, never a permanent delete.
      return;
    } catch (error) {
      if (attempt === TRASH_RETRIES || !fs.existsSync(file)) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRASH_RETRY_DELAY));
    }
  }
}

async function pickFolder(title) {
  const result = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

/** The name of a clip as the user sees it, for the status bar. */
function clipLabel(id) {
  try {
    const clip = library.get(id);
    return meta.data[clip.key]?.title || clip.name;
  } catch {
    return '';
  }
}

/** One export, overwrite or revert at a time. `label` names it in the status bar of the window. */
async function runJob(task, label = '') {
  if (exportJob) throw new Error(t('main.busy'));
  exportJob = new AbortController();
  send('job', { label });
  const { signal } = exportJob;
  // `phase` names a check that runs before or after the encode, for the text shown with the bar.
  const onProgress = (value, phase) => {
    send('progress', value, phase);
    setTaskbarProgress(value);
  };
  // A line of the log under the bar. With `live`, the text replaces the last line: the step that runs.
  const onLog = (text, live = false) => send('jobLog', text, live);
  try {
    return await task({ signal, onProgress, onLog });
  } catch (error) {
    if (signal.aborted) return { canceled: true };
    throw error;
  } finally {
    exportJob = null;
    send('job', null);
    refreshFreeSpace().catch((error) => console.error('Cannot read the free space:', error.message));
    setTaskbarProgress(-1);
    sortClips(); // Clips that had to wait for the job.
    duplicates.schedule();
  }
}

function sortClips() {
  gameFolders?.run().catch((error) => console.error('Sorting by game failed:', error.message));
}

/** Nothing may be reading a file that gets replaced, renamed or binned. */
const filesFree = (task) => detector.withFilesFree(() => duplicates.withFilesFree(task));

/** Group after group. Each one is done or kept as it was; a failure does not stop the others. */
function joinReplays(groups, mode) {
  return runJob(async ({ signal, onProgress }) => {
    const done = [];
    const skipped = [];
    for (const [i, ids] of groups.entries()) {
      if (signal.aborted) break;
      const step = (value, phase) => onProgress((i + value) / groups.length, phase);
      step(0);
      try {
        const leave = [openId, closed.until > Date.now() && closed.id].filter(Boolean);
        done.push(await filesFree(() => duplicates.resolve(ids, mode === 'trim' ? 'trim' : 'join', { signal, onProgress: step, leave })));
      } catch (error) {
        if (signal.aborted) break;
        const names = ids.map((id) => {
          try {
            return library.get(id).name;
          } catch {
            return '';
          }
        }).filter(Boolean);
        skipped.push({ name: names.join(', '), reason: error.message });
      }
    }
    return { done, skipped, canceled: signal.aborted };
  }, t('status.join'));
}

const picked = new Set(); // Programs chosen in the file dialog.

/** The spelling a new game takes: that of its clips, then that of the built-in list, then the one given. */
async function spellingOf(name) {
  const slug = plainName(name);
  const { GAMES } = await gameList;
  return library.list().map((clip) => clip.game).find((game) => game && plainName(game) === slug)
    || GAMES.find((game) => plainName(game) === slug)
    || name;
}

/**
 * The program of a game: the one the user gave, or the one found before, or else it is looked for
 * now, with the processes OBS captured in its clips. What is found is kept with the game.
 */
async function programOf(slug, again = false) {
  const known = userGames.programOf(slug);
  if (known && (known.picked || !again) && fs.existsSync(known.file)) return known;
  if (again) programs.forget(); // The game may have moved or been installed meanwhile.
  const processes = new Set(library.list()
    .filter((clip) => clip.game && plainName(clip.game) === slug)
    .map((clip) => meta.data[clip.key]?.capturedProcess)
    .filter(Boolean));
  const file = await programs.find(slug, [...processes]);
  if (!file) return known;
  userGames.setFound(slug, file);
  return { file, picked: false };
}

async function addGame({ source, name, program } = {}) {
  let entry;
  if (source === 'list') {
    entry = { source, name: String(name || ''), programs: [] };
  } else if (source === 'exe') {
    // Only a program the user picked in the file dialog.
    if (!picked.has(program)) throw new Error(t('games.pickFirst'));
    entry = { source, name: String(name || ''), program, programs: [] };
  } else {
    const game = installed.find((candidate) => candidate.source === source && candidate.name === name);
    if (!game) throw new Error(t('games.uninstalled'));
    const programs = await programsIn(game.dir);
    entry = { source, name: game.name, programs, program: game.program || mainProgram(programs, game) };
  }
  const added = userGames.add({ ...entry, name: await spellingOf(entry.name.trim()) });
  await icons.renew(added).catch((error) => console.error(`No logo for ${added}:`, error.message));
  library.emit('change'); // Clips captured with its programs now have its name.
  return added;
}

function runExport(id, request) {
  return runJob(async (job) => {
    const clip = library.get(id);
    const result = await exportClip(clip, request, { outDir: settings.data.exportDir, ...job });
    const { loadEdit, outputEdit } = await editModel;
    await library.addExport(result.path, clip, outputEdit(loadEdit(request.edit, clip)).pieces);
    return result;
  }, t('status.export', { name: clipLabel(id) }));
}

/** Ready for Ctrl+V. When the copy fails, the file stays until the next one, to drag by hand. */
function sendToDiscord(id, request) {
  return runJob(async (job) => {
    const clip = library.get(id);
    const result = await exportClip(clip, request, { ...job, save: (out) => discordFiles.place(out, clip.name) });
    job.onLog(t('log.clipboard'));
    result.copied = await clipboardFiles.copy(result.path).then(() => true, (error) => {
      console.error('Cannot copy the export to the clipboard:', error.message);
      return false;
    });
    discordFiles.sent(result.path, result.copied);
    discordFiles.clear({ force: true }).catch((error) => console.error('Cannot clear Discord files:', error.message));
    return result;
  }, t('status.discord', { name: clipLabel(id) }));
}

/** Free and total space of the disks that hold clips. A disconnected drive is left out. */
async function diskSpace() {
  const roots = [...new Set(settings.data.folders.map((dir) => path.parse(path.resolve(dir)).root.toUpperCase()))];
  const disks = [];
  for (const root of roots) {
    try {
      const { bavail, blocks, bsize } = await fs.promises.statfs(root);
      disks.push({ root, free: bavail * bsize, total: blocks * bsize });
    } catch {
      // Disconnected drive.
    }
  }
  return disks;
}

/**
 * The free space shown in the status bar, read again every minute and after each job. Rounded to a
 * tenth of a GB, so that a clip being written does not send the whole state again every minute.
 */
async function refreshFreeSpace() {
  const disks = (await diskSpace()).map(({ root, free, total }) => ({
    root, free: Math.round(free / 1e8) * 1e8, low: free < Math.max(10e9, total * 0.05),
  }));
  if (JSON.stringify(disks) === JSON.stringify(freeDisks)) return;
  freeDisks = disks;
  publish();
}

/** Free space on the disks that hold clips, and whether OBS is open (it shares the video encoder). */
async function storage() {
  const disks = await diskSpace();
  const obs = await new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'], { windowsHide: true },
      (error, stdout) => resolve(!error && /obs64\.exe/i.test(stdout)));
  });
  return { disks, obs };
}

/** One clip after the other. Each one is done or kept as it was; a failure does not stop the others. */
function compress(ids) {
  return runJob(async ({ signal, onProgress }) => {
    const done = [];
    const skipped = [];
    for (const [i, id] of ids.entries()) {
      if (signal.aborted) break;
      let clip;
      try {
        clip = library.get(id);
      } catch {
        continue; // Deleted meanwhile.
      }
      const name = meta.data[clip.key]?.title || clip.name;
      const step = (value, phase) => onProgress((i + value) / ids.length, phase);
      step(0);
      try {
        const result = await filesFree(() => compressor.compress(clip, { signal, onProgress: step }));
        if (result.skipped) skipped.push({ name, reason: result.skipped });
        else done.push({ name, ...result });
      } catch (error) {
        if (signal.aborted) break;
        skipped.push({ name, reason: error.message });
      }
    }
    return { done, skipped, canceled: signal.aborted };
  }, t('status.compress'));
}

function registerIpc() {
  handle('state', state);
  handle('rescan', () => library.scan());
  handle('update', (ids, patch) => library.update(ids, patch));
  handle('rename', (id, name) => filesFree(() => library.rename(id, name)));
  handle('analysis', (id) => derived.analysis(library.get(id)));
  handle('proxy', async (id) => {
    await derived.proxy(library.get(id));
  });
  handle('reveal', (id) => shell.showItemInFolder(library.get(id).path));
  handle('copyPath', (id) => clipboard.writeText(library.get(id).path));
  handle('export', (id, request) => runExport(id, request));
  // Under the size Discord takes, with every track heard mixed into one: Discord plays only the
  // first. The clip itself keeps all its tracks.
  handle('discord', (id, request) => sendToDiscord(id, { ...request, mode: 'discord', separate: false }));
  handle('cancelExport', () => exportJob?.abort());
  // A new format gives a new id. The editor opens it again, and it must not move meanwhile.
  const followOpen = (id) => (result) => {
    if (result?.id && openId === id) openId = result.id;
    return result;
  };
  handle('overwrite', (id, request) => runJob((job) =>
    filesFree(() => versions.overwrite(library.get(id), request, job)).then(followOpen(id)),
  t('status.overwrite', { name: clipLabel(id) })));
  handle('revert', (id) => runJob(() =>
    filesFree(() => versions.revert(library.get(id))).then(followOpen(id)),
  t('status.revert', { name: clipLabel(id) })));
  handle('revealExport', (file) => {
    const inDiscord = path.dirname(path.dirname(file)) === discordFiles.dir;
    if (path.dirname(file) === settings.data.exportDir || inDiscord) shell.showItemInFolder(file);
  });

  handle('trash', (ids) => filesFree(async () => {
    const failed = [];
    for (const id of ids) {
      const clip = library.get(id);
      try {
        if (clip.busy) throw new Error('Still recording');
        await trashWhenFree(clip.path); // Recycle Bin, never a permanent delete.
        library.forget(clip.id); // `id` may be the one it had before a move.
        // Its kept versions follow it there.
        for (const file of versions.unused(clip.key)) {
          await trashWhenFree(file).catch((error) => console.error(`Cannot trash ${file}:`, error.message));
        }
      } catch {
        failed.push(clip.name);
      }
    }
    library.schedule(500);
    return failed;
  }));

  handle('addCategory', (name) => organizer.addCategory(name));
  handle('renameCategory', (from, to) => organizer.renameCategory(from, to));
  handle('removeCategory', (name) => organizer.removeCategory(name));
  handle('addTag', (name) => organizer.addTag(name));
  handle('renameTag', (from, to) => organizer.renameTag(from, to));
  handle('removeTag', (name) => organizer.removeTag(name));

  handle('moments', (id, change) => {
    const added = organizer.editMoments(id, change);
    if (change.redetect) detector.retry(id);
    return added;
  });
  handle('watching', (id) => {
    if (openId && !id) {
      closed = { id: openId, until: Date.now() + CLOSED_MS };
      setTimeout(sortClips, CLOSED_MS + 100); // It may have waited for the editor to close.
    }
    openId = id || null;
    if (id) detector.prefer(id);
  });
  handle('setDetection', (on) => {
    settings.data.detectMoments = on === true;
    settings.save();
    if (detectionOn()) detector.pump();
    else detector.interrupt();
    publish();
  });

  handle('setTheme', (id) => {
    if (!Object.hasOwn(THEME_BARS, id)) throw new Error(t('main.unknownTheme'));
    settings.data.theme = id;
    settings.save();
    const [color, symbolColor] = themeBar();
    for (const window of [win, shortcutsWindow]) {
      if (!window || window.isDestroyed()) continue;
      window.setBackgroundColor(color);
      window.setTitleBarOverlay({ color, symbolColor, height: window === win ? 51 : 46 });
    }
    publish();
  });
  handle('setLanguage', (id) => {
    if (!LANGUAGES.some((language) => language.id === id)) throw new Error(t('main.unknownLanguage'));
    settings.data.language = id;
    settings.save();
    i18n.setLanguage(id);
    // Every text of a page is built in its language, so the pages open again.
    for (const [window, page] of [[win, 'index.html'], [shortcutsWindow, 'shortcuts.html']]) {
      if (window && !window.isDestroyed()) window.loadURL(pageUrl(page));
    }
  });
  handle('showShortcuts', () => openShortcuts());
  handle('fullScreen', fullScreen);
  handle('storage', storage);
  handle('compress', compress);
  handle('joinReplays', joinReplays);

  handle('chooseLogo', async (game) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('logo.pickTitle', { game }),
      properties: ['openFile'],
      filters: [{ name: t('main.images'), extensions: IMAGES }],
    });
    if (canceled) return;
    await icons.choose(game, filePaths[0]);
    publish();
  });
  handle('automaticLogo', async (game) => {
    await icons.automatic(game);
    publish();
  });

  handle('installedGames', async () => {
    installed = await installedGames();
    return installed.map(({ source, name }) => ({ source, name }));
  });
  handle('pickProgram', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('games.programTitle'),
      properties: ['openFile'],
      filters: [{ name: t('main.programs'), extensions: ['exe'] }],
    });
    if (canceled) return null;
    const program = filePaths[0];
    picked.add(program);
    // "Some_Game-Win64-Shipping.exe" is offered as "Some Game", which the user can change.
    const name = path.parse(program).name.replace(/[-_](win64|win32|shipping|x64|dx1[12])/gi, '').replaceAll('_', ' ').trim();
    return { program, name: await spellingOf(name) };
  });
  handle('addGame', (choice) => addGame(choice));
  handle('removeGame', (name) => {
    userGames.remove(name);
    library.emit('change');
  });
  handle('sortPreview', (dir) => gameFolders.preview(dir));
  handle('setSorting', async (dir, on) => {
    const result = await gameFolders.turn(dir, on === true);
    publish();
    return result;
  });

  // The list changes at once. Reading a big folder takes a while: its clips come in when it is done.
  const rescanFolders = () => {
    settings.save();
    publish();
    library.start().catch((error) => console.error('Scan failed:', error));
  };

  handle('addFolder', async () => {
    const dir = await pickFolder(t('settings.addFolderTitle'));
    if (!dir) return 'canceled';
    if (settings.data.folders.some((folder) => path.resolve(folder).toLowerCase() === path.resolve(dir).toLowerCase())) {
      return 'known';
    }
    settings.data.folders.push(dir);
    rescanFolders();
    return 'added';
  });

  handle('removeFolder', async (dir) => {
    settings.data.folders = settings.data.folders.filter((folder) => folder !== dir);
    // Added back later, it is not sorted again without asking.
    settings.data.sortRoots = (settings.data.sortRoots || []).filter((folder) => folder !== dir);
    rescanFolders();
  });

  handle('setExportDir', async () => {
    const dir = await pickFolder(t('settings.exportDir'));
    if (!dir) return;
    settings.data.exportDir = dir;
    settings.save();
    send('changed', state());
  });

  // The welcome screen.
  handle('welcomeInfo', () => ({ obs: obsState(obsDir(), settings.data.folders) }));
  // Only a folder OBS records into: the page cannot name any path.
  handle('addObsFolder', (dir) => {
    const found = obsState(obsDir(), settings.data.folders).folders.find((folder) => same(folder.path, dir));
    if (!found?.exists) throw new Error(t('welcome.obsGone'));
    if (found.covered) return 'known';
    settings.data.folders.push(found.path);
    rescanFolders();
    return 'added';
  });
  handle('welcomeDone', () => {
    welcome.done(t('welcome.fileText'));
    send('changed', state());
  });
  handle('installUpdate', () => {
    if (exportJob) throw new Error(t('main.busy'));
    return updater.install();
  });
  handle('newsSeen', () => {
    settings.data.seenVersion = app.getVersion();
    settings.save();
    send('changed', state());
  });

  // Native drag and drop, to drop clips straight into Discord or Explorer.
  ipcMain.on('drag', (event, ids) => {
    if (!trusted(event)) return;
    try {
      const clips = ids.map((id) => library.get(id));
      const { name } = derived.thumbOf(clips[0], library.thumbOf(clips[0]));
      let icon = nativeImage.createFromPath(path.join(derived.dir, name));
      if (icon.isEmpty()) icon = nativeImage.createFromPath(ICON);
      event.sender.startDrag({ file: clips[0].path, files: clips.map((c) => c.path), icon: icon.resize({ width: 128 }) });
    } catch (error) {
      console.error('Drag failed:', error.message);
    }
  });
}

/** The pages build their texts once, in the language and theme given in their address. */
function pageUrl(page) {
  const theme = encodeURIComponent(settings.data.theme || 'periph');
  return `shelf://app/ui/${page}?lang=${i18n.language()}&theme=${theme}`;
}

/** Shortcuts in a window of their own, which can stay open next to the app. */
function openShortcuts() {
  if (shortcutsWindow && !shortcutsWindow.isDestroyed()) {
    if (shortcutsWindow.isMinimized()) shortcutsWindow.restore();
    shortcutsWindow.focus();
    return;
  }
  const [color, symbolColor] = themeBar();
  shortcutsWindow = new BrowserWindow({
    title: t('shortcuts.window'),
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    backgroundColor: color,
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color, symbolColor, height: 46 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  shortcutsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shortcutsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  shortcutsWindow.on('closed', () => { shortcutsWindow = null; });
  shortcutsWindow.loadURL(pageUrl('shortcuts.html'));
}

/** The window covers the screen only while the editor shows the video alone. */
function fullScreen(on) {
  // Kept before the window covers the screen, where it is no longer maximized.
  if (on && !win.isFullScreen()) maximizedBefore = win.isMaximized();
  if (Boolean(on) !== win.isFullScreen()) win.setFullScreen(Boolean(on));
  return win.isFullScreen();
}

function createWindow() {
  const [barColor, barSymbols] = themeBar();
  const primary = screen.getPrimaryDisplay();
  const areas = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)].map((display) => display.workArea);
  const kept = settings.data.window;
  const place = placeWindow(kept, areas, { width: 980, height: 640 });
  win = new BrowserWindow({
    title: 'ClipShelf',
    width: 1440,
    height: 900,
    ...place,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: barColor,
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: barColor, symbolColor: barSymbols, height: 51 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Uncaught errors of the page arrive here as console errors.
  win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'error') log.write('PAGE', message, `(${String(sourceId).split('/').pop()}:${lineNumber})`);
  });
  win.on('unresponsive', () => log.write('WARN', 'The window stopped responding.'));
  win.on('responsive', () => log.write('INFO', 'The window responds again.'));
  win.once('ready-to-show', () => {
    if (place && kept.maximized) win.maximize();
    win.show();
  });
  // Kept on close, before the window is gone; the settings are written when the app quits.
  win.on('close', () => {
    settings.data.window = windowState(win, { maximizedBefore });
    settings.save();
  });
  win.on('closed', () => shortcutsWindow?.close());
  // Back from Discord: the file pasted there may no longer be on the clipboard.
  win.on('focus', () => discordFiles.clear().catch((error) => console.error('Cannot clear Discord files:', error.message)));
  win.loadURL(pageUrl('index.html'));
}

// While the installer of an update runs, this would be the old version, locking the files it
// replaces before being closed by it: the app does not open at all.
if (!app.requestSingleInstanceLock() || (app.isPackaged && updateInstalling())) {
  app.quit();
} else {
  // Only the first instance writes, so that two processes never share the file.
  log = new Log(path.join(app.getPath('userData'), 'logs'));
  log.captureConsole();
  log.captureCrashes();
  // A start that follows no "Quit" line means the previous run ended badly.
  log.write('INFO', `Start: ClipShelf ${app.getVersion()}, Electron ${process.versions.electron}, Windows ${os.release()}`);
  app.on('render-process-gone', (_, contents, { reason, exitCode }) => {
    log.write('FATAL', `Page gone (${reason}, code ${exitCode}): ${contents.getURL().split('?')[0]}`);
  });
  app.on('child-process-gone', (_, { type, reason, exitCode, name }) => {
    if (reason !== 'clean-exit') log.write('ERROR', `${name || type} process gone (${reason}, code ${exitCode})`);
  });

  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const data = app.getPath('userData');
    fs.mkdirSync(data, { recursive: true });
    const videos = process.env.CLIPSHELF_VIDEOS || app.getPath('videos');

    // Settings and clip data are the user's own work, so they keep two weeks of daily copies.
    // The index and the duplicate results can be read again from the clips.
    settings = new Store(path.join(data, 'settings.json'), {}, { backups: BACKUP_DAYS });
    i18n.setLanguage(settings.data.language); // English unless another language was chosen.
    if (!Array.isArray(settings.data.folders)) settings.data.folders = defaultFolders(videos);
    // Made by the first export (exporter.js): until then the user may choose another one.
    settings.data.exportDir ||= path.join(videos, 'Exports');
    welcome = new Welcome(data);
    // What is new is said once per version, to those who used an older one; the welcome screen
    // speaks to the others. CLIPSHELF_NEWS=off keeps it away from the checks.
    if (welcome.needed || process.env.CLIPSHELF_NEWS === 'off') settings.data.seenVersion = app.getVersion();
    settings.save();
    meta = new Store(path.join(data, 'clips.json'), {}, { backups: BACKUP_DAYS });
    index = new Store(path.join(data, 'index.json'));

    userGames = new UserGames(settings);
    const obsLogs = new ObsLogs(path.join(obsDir(), 'logs'), userGames);
    library = new Library({ settings, meta, index, obsLogs, games: userGames });
    derived = new Derived(path.join(data, 'derived'));
    versions = new Versions({ library, trashItem: trashWhenFree });
    compressor = new Compressor({ library, trashItem: trashWhenFree });
    duplicates = new Duplicates({
      library,
      store: new Store(path.join(data, 'duplicates.json')),
      trashItem: trashWhenFree,
      busy: () => Boolean(exportJob),
    });
    duplicates.on('change', () => publish());
    organizer = new Organizer({ library, settings });
    programs = new Programs();
    icons = new GameIcons({
      dir: path.join(data, 'logos'),
      readShortcut: (file) => shell.readShortcutLink(file),
      programOf: (slug, again) => programOf(slug, again),
      decodePng: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        const { width, height } = image.getSize();
        const data = Uint8Array.from(image.toBitmap());
        // Windows gives BGRA.
        for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
        return { width, height, data };
      },
      encodePng: ({ width, height, data }) => {
        const bgra = Buffer.from(data);
        for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
        return nativeImage.createFromBitmap(bgra, { width, height }).toPNG();
      },
    });
    detector = new Detector({ library, enabled: detectionOn });
    // Every move is written down, so that a file can be found again whatever happens.
    const journal = path.join(data, 'moves.log');
    gameFolders = new GameFolders({
      library,
      settings,
      journal: (from, to) => fs.promises.appendFile(journal, `${new Date().toISOString()}\t${from}\t${to}\n`)
        .catch((error) => console.error('Cannot write the moves log:', error.message)),
      canMove: () => !exportJob,
      leave: () => [openId, closed.until > Date.now() && closed.id].filter(Boolean),
      withFilesFree: filesFree,
    });
    derived.prune();
    // At most every 5 s: a scan changes the library many times in a row.
    let spaceRead = 0;
    const freeSpace = () => {
      if (Date.now() - spaceRead < 5e3) return;
      spaceRead = Date.now();
      refreshFreeSpace().catch((error) => console.error('Cannot read the free space:', error.message));
    };
    freeSpace();
    setInterval(freeSpace, 60e3).unref();
    library.on('change', freeSpace);
    discordFiles = new DiscordFiles({ dir: path.join(data, 'Discord'), held: () => clipboardFiles.held() });
    discordFiles.clear({ force: true }).catch((error) => console.error('Cannot clear Discord files:', error.message));
    // After the listener of the detector, so that the state says what it started.
    library.on('change', () => {
      scanned = true;
      const list = state();
      send('changed', list);
      icons.refresh([...list.clips.map((clip) => clip.game), ...list.games.map((game) => game.name)])
        .then((changed) => changed && publish())
        .catch((error) => console.error('Logos failed:', error.message));
      sortClips();
    });

    protocol.handle('shelf', createHandler({ library, derived, icons }));
    registerIpc();
    createWindow();
    updater = new Updater({ app, onChange: () => publish(), busy: () => Boolean(exportJob) });
    updater.start();
    library.start().catch((error) => console.error('Initial scan failed:', error));
    // The first export would otherwise wait for the test of the AMD encoder.
    setTimeout(() => hasAmf(), 5000);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    detector?.stop();
    duplicates?.stop();
    library?.stop();
    gameFolders?.stop();
    killAll();
    for (const store of [settings, meta, index, duplicates?.store]) store?.flush();
    log.write('INFO', 'Quit');
  });
}
