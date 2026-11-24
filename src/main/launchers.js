// Games installed on this PC, read from the files of their launchers: Steam, Epic, Riot and the Xbox app.
// Only local files are read. Nothing is downloaded and no launcher is started.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const plainName = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const entries = (dir, options) => fs.readdir(dir, options).catch(() => []);
const readText = (file) => fs.readFile(file, 'utf8').catch(() => '');

// Steam installs tools next to games. Spacewar (480) is its test app.
const STEAM_TOOLS = /redistributable|runtime|proton|\bsdk\b|dedicated server|connect services|steamvr/i;
const STEAM_HIDDEN = new Set(['228980', '480']);

// Riot names its products by code. Only those with install settings are installed.
const RIOT_NAMES = {
  valorant: 'Valorant',
  league_of_legends: 'League of Legends',
  teamfighttactics: 'Teamfight Tactics',
  bacon: 'Legends of Runeterra',
  lion: '2XKO',
};

// Programs that ship with games but are never the game: installers, crash reporters, anti-cheat.
const HELPERS = /^(unins|uninstall|setup|install|vc_?redist|vcredist|dxsetup|dxwebsetup|dotnet|directx|crash(?:report|pad|handler|sender)|bugreport|errorreport|report|epicwebhelper|unitycrashhandler|ue\d?prereq|prereq|easyanticheat|eac|battleye|be(service|launcher)|cef|steamerrorreporter|quicksfv|checkenv|8za|7z|helper|updater|update|patcher)/i;
const SKIPPED_FOLDERS = /^(_commonredist|redist|redistributables|directx|dotnet|vcredist|support|__installer|installer|prerequisites|easyanticheat|battleye)$/i;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 20000;

// "Minecraft" is installed as "Minecraft Launcher".
const SUFFIXES = ['launcher', 'client', 'game', 'live', 'edition', 'javaedition', 'bedrockedition', 'forwindows',
  'windows', 'pc', 'remastered', 'enhanced', 'definitiveedition', 'beta'];

/** Whether an installed name is that of the game: the same, or with a word such as "Launcher" added. */
function sameGame(candidate, slug) {
  if (!candidate || !slug) return false;
  if (candidate === slug || candidate === `the${slug}`) return true;
  return slug.length >= 4 && SUFFIXES.some((suffix) => candidate === slug + suffix);
}

/** The value of a map whose plain name is that of the game, or null. */
const findGame = (map, slug) => {
  if (map.has(slug)) return map.get(slug);
  for (const [name, value] of map) if (sameGame(name, slug)) return value;
  return null;
};

function steamPath() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (error, out) => {
      const found = !error && out.match(/REG_SZ\s+(.+?)\s*$/m);
      resolve(found ? path.normalize(found[1]) : '');
    });
  });
}

/**
 * The apps of every Steam library: plain name -> { id, name, dir }. Libraries are often on hard
 * disks that sleep, so they are read side by side: the wait is that of the slowest disk, not the sum.
 */
async function steamApps(steam) {
  const apps = new Map();
  if (!steam) return apps;
  const folders = await readText(path.join(steam, 'steamapps', 'libraryfolders.vdf'));
  const roots = new Set([steam]);
  for (const [, root] of folders.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(root.replaceAll('\\\\', '\\'));

  const libraries = await Promise.all([...roots].map(async (root) => {
    const dir = path.join(root, 'steamapps');
    const found = [];
    for (const file of await entries(dir)) {
      const id = /^appmanifest_(\d+)\.acf$/i.exec(file)?.[1];
      if (!id) continue;
      const text = await readText(path.join(dir, file));
      const name = text.match(/"name"\s+"([^"]+)"/)?.[1];
      const install = text.match(/"installdir"\s+"([^"\\/]+)"/)?.[1];
      if (name) found.push([plainName(name), { id, name, dir: install && path.join(dir, 'common', install) }]);
    }
    return found;
  }));
  for (const [slug, app] of libraries.flat()) if (!apps.has(slug)) apps.set(slug, app);
  return apps;
}

/**
 * The drive letters of the disks of this PC. Network drives are never listed there, and they are
 * left out on purpose: Windows waits about 20 seconds on one that cannot be reached.
 */
function localDrives() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SYSTEM\\MountedDevices'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
      const letters = error ? [] : [...out.matchAll(/^\s*\\DosDevices\\([A-Z]):/gim)].map((match) => match[1].toUpperCase());
      resolve(letters.length ? [...new Set(letters)].sort() : [...'CDEFGHIJKLMNOPQRSTUVWXYZ']);
    });
  });
}

/** Folders where the Xbox app installs games, one per local drive. */
async function xboxFolders() {
  return (await localDrives()).map((drive) => `${drive}:\\XboxGames`);
}

/** Games of the Xbox app: plain name -> { name, dir, declared logos, program, known: has a manifest }. `roots` may be a promise. */
async function xboxGames(roots) {
  const games = new Map();
  // Every drive is looked at: side by side, for the same reason as Steam libraries.
  const listed = await Promise.all((await roots).map(async (root) => [root, await entries(root)]));
  for (const [root, folders] of listed) {
    for (const folder of folders) {
      const dir = path.join(root, folder, 'Content');
      const manifest = await readText(path.join(dir, 'appxmanifest.xml')) || await readText(path.join(dir, 'MicrosoftGame.config'));
      const name = manifest.match(/<DisplayName>([^<]+)</)?.[1] || manifest.match(/DisplayName="([^"]+)"/)?.[1] || folder;
      // Only names of files in this folder: a manifest never leads elsewhere.
      const declared = [...manifest.matchAll(/(?:Square150x150Logo|Square44x44Logo|StoreLogo)="([\w.-]+\.png)"/g)].map((m) => m[1]);
      const executable = manifest.match(/<Executable\b[^>]*\bName="([\w .-]+\.exe)"/i)?.[1];
      if (!games.has(plainName(name))) {
        games.set(plainName(name), { name, dir, declared, known: Boolean(manifest), program: executable && path.join(dir, executable) });
      }
    }
  }
  return games;
}

/** Games of the Epic launcher: plain name -> { name, dir, program }. */
async function epicGames(dir) {
  const games = new Map();
  for (const name of await entries(dir)) {
    if (!name.endsWith('.item')) continue;
    try {
      const item = JSON.parse(await readText(path.join(dir, name)));
      if (item.DisplayName && item.InstallLocation && item.LaunchExecutable) {
        games.set(plainName(item.DisplayName), {
          name: item.DisplayName,
          dir: item.InstallLocation,
          program: path.join(item.InstallLocation, item.LaunchExecutable),
        });
      }
    } catch {
      // Not a manifest of a game.
    }
  }
  return games;
}

/** Installed Riot games: [{ name, dir }]. */
async function riotGames(programData) {
  const root = path.join(programData, 'Riot Games', 'Metadata');
  const games = [];
  for (const product of await entries(root)) {
    const code = /^(.+)\.live$/.exec(product)?.[1];
    if (!code) continue;
    const settings = await readText(path.join(root, product, `${product}.product_settings.yaml`));
    const dir = settings.match(/^product_install_full_path:\s*"([^"]+)"/m)?.[1];
    if (dir) games.push({ name: RIOT_NAMES[code] || code.replaceAll('_', ' '), dir: path.normalize(dir) });
  }
  return games;
}

/** Every game the launchers know: [{ source, name, dir, program? }], by name. */
async function installedGames({ env = process.env, findSteam = steamPath, xboxRoots = xboxFolders() } = {}) {
  const { ProgramData = '' } = env;
  const games = [];
  const [steam, epic, riot, xbox] = await Promise.all([
    findSteam().then(steamApps),
    epicGames(path.join(ProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')),
    riotGames(ProgramData),
    xboxGames(xboxRoots),
  ]);
  for (const [, app] of steam) {
    if (!STEAM_HIDDEN.has(app.id) && !STEAM_TOOLS.test(app.name) && app.dir) {
      games.push({ source: 'steam', name: app.name, dir: app.dir });
    }
  }
  for (const [, game] of epic) games.push({ source: 'epic', ...game });
  for (const game of riot) games.push({ source: 'riot', ...game });
  for (const [, { name, dir, program, known }] of xbox) {
    if (known) games.push({ source: 'xbox', name, dir, program }); // Without a manifest, a folder of saves.
  }
  return games.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

const isHelper = (file) => HELPERS.test(path.basename(file));

/**
 * The programs of a game folder, so that OBS logs that name any of them are recognised.
 * Unreal games start a small program that runs the real one, deep in Binaries, so subfolders count.
 */
async function programsIn(dir) {
  const found = [];
  let seen = 0;
  const visit = async (folder, depth) => {
    for (const entry of await entries(folder, { withFileTypes: true })) {
      if ((seen += 1) > MAX_ENTRIES) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_FOLDERS.test(entry.name)) await visit(full, depth + 1);
      } else if (/\.exe$/i.test(entry.name) && !isHelper(entry.name)) {
        found.push(full);
      }
    }
  };
  if (dir) await visit(dir, 1);
  return found;
}

/** The program whose icon stands for the game: named like it, near the top of its folder. */
function mainProgram(programs, { name, dir }) {
  const names = [plainName(name), plainName(path.basename(dir || ''))].filter(Boolean);
  const depth = (file) => path.relative(dir || path.dirname(file), file).split(path.sep).length;
  const ranked = [...programs].sort((a, b) => depth(a) - depth(b));
  return ranked.find((file) => names.includes(plainName(path.parse(file).name)))
    || ranked.find((file) => names.some((slug) => plainName(path.parse(file).name).startsWith(slug.slice(0, 4))))
    || ranked[0]
    || '';
}

module.exports = {
  installedGames, programsIn, mainProgram, isHelper, plainName, sameGame, findGame, localDrives,
  steamPath, steamApps, xboxFolders, xboxGames, epicGames, riotGames,
};
