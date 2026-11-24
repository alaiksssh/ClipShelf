// Where the program of a game is on this PC. OBS logs name only the process, and launchers know only
// their own games, so Windows' own records of the programs that ran are read too: they cover games
// started from Downloads or from any other folder. Everything is read; nothing on the PC is changed.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  plainName, sameGame, findGame, installedGames, programsIn, mainProgram, isHelper, localDrives,
} = require('./launchers');
const { programKey } = require('./userGames');

// Programs that come with games but are never them, wherever the word is in their name.
const NOT_THE_GAME = /setup|install|uninst|redist|updater|patcher|crash|report/i;
// Minecraft runs in Java. Its launchers keep their own Java, so the one in their folder is the game.
const MINECRAFT = new Set(['minecraft', 'minecraftjavaedition']);
// A game seen for the first time is often still running: an older reading of the PC is done again.
const FRESH_MS = 2 * 60 * 1000;
const MINECRAFT_FOLDERS = /[\\/](modrinthapp|\.minecraft|prismlauncher|polymc|multimc|curseforge|atlauncher|gdlauncher|\.lunarclient|\.feather|\.tlauncher)[\\/]/i;

/**
 * Programs Windows remembers, and those running now: [{ file, name }]. The name is the one Windows
 * shows for the program, or the title of its window.
 * - MuiCache: every program started from the Explorer, from any folder.
 * - Compatibility Assistant: programs started by hand, with their full path.
 * - GameConfigStore: what the Game Bar took for a game.
 */
const REMEMBERED = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$found = New-Object System.Collections.Generic.List[object]
$mui = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache'
$compat = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store'
try {
  (Get-ItemProperty -LiteralPath $mui -ErrorAction Stop).PSObject.Properties | ForEach-Object {
    if ($_.Name -match '^(.+\.exe)\.FriendlyAppName$') { $found.Add([pscustomobject]@{ file = $Matches[1]; name = [string]$_.Value }) }
  }
} catch {}
try {
  (Get-Item -LiteralPath $compat -ErrorAction Stop).GetValueNames() | Where-Object { $_ -match '\.exe$' } |
    ForEach-Object { $found.Add([pscustomobject]@{ file = $_; name = '' }) }
} catch {}
Get-ChildItem -LiteralPath 'HKCU:\System\GameConfigStore\Children' -ErrorAction SilentlyContinue | ForEach-Object {
  $file = $_.GetValue('MatchedExeFullPath')
  if ($file) { $found.Add([pscustomobject]@{ file = [string]$file; name = '' }) }
}
Get-Process | ForEach-Object { if ($_.Path) { $found.Add([pscustomobject]@{ file = $_.Path; name = [string]$_.MainWindowTitle }) } }
ConvertTo-Json -InputObject $found.ToArray() -Compress
`;

function rememberedPrograms() {
  const script = Buffer.from(REMEMBERED, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (error, out) => {
        try {
          const list = error ? [] : JSON.parse(out.trim() || '[]');
          resolve((Array.isArray(list) ? list : [list]).filter((item) => typeof item?.file === 'string'));
        } catch {
          resolve([]);
        }
      });
  });
}

/** Folders where games are often unpacked by hand: Downloads, the desktop, and a Games folder on each disk. */
async function looseFolders(env = process.env) {
  const home = env.USERPROFILE || '';
  const drives = await localDrives();
  return [home && path.join(home, 'Downloads'), home && path.join(home, 'Desktop'), ...drives.map((drive) => `${drive}:\\Games`)]
    .filter(Boolean);
}

const isFile = (file) => fs.stat(file).then((stat) => stat.isFile(), () => false);
const depth = (file) => file.split(/[\\/]+/).length;
const usable = (file) => /\.exe$/i.test(file) && !isHelper(file) && !NOT_THE_GAME.test(path.basename(file));

/** The first file that exists, nearest the top of its folders. */
async function nearestTop(files) {
  const unique = [...new Map(files.map((file) => [path.resolve(file).toLowerCase(), path.resolve(file)])).values()];
  for (const file of unique.sort((a, b) => depth(a) - depth(b) || a.length - b.length)) {
    if (await isFile(file)) return file;
  }
  return '';
}

/**
 * `remembered()` resolves to the programs Windows knows, `launchers()` to the games of the launchers,
 * `folders()` to the folders to look into. Each is read once, until `forget()`.
 */
class Programs {
  constructor({
    remembered = rememberedPrograms, launchers = () => installedGames(), folders = () => looseFolders(),
  } = {}) {
    Object.assign(this, { remembered, launchers, folders });
    this.sources = null;
    this.scannedAt = 0;
  }

  forget() {
    this.sources = null;
  }

  async scan() {
    this.scannedAt = Date.now();
    const [remembered, launchers, folders] = await Promise.all([
      this.remembered().catch(() => []),
      this.launchers().catch(() => []),
      this.folders().catch(() => []),
    ]);
    // Folders on several disks are read side by side, as Steam libraries are.
    const loose = (await Promise.all(folders.map((dir) => programsIn(dir).catch(() => [])))).flat();
    return {
      known: [...remembered, ...loose.map((file) => ({ file, name: '' }))].filter((item) => /\.exe$/i.test(item.file)),
      launchers: new Map(launchers.map((game) => [plainName(game.name), game])),
    };
  }

  /** The program of a game, from its name and the processes OBS captured for it, or ''. */
  async find(slug, processes = []) {
    if (!slug) return '';
    const found = await this.lookup(slug, processes);
    if (found || Date.now() - this.scannedAt < FRESH_MS) return found;
    this.forget();
    return this.lookup(slug, processes);
  }

  async lookup(slug, processes) {
    this.sources ??= this.scan();
    const { known, launchers } = await this.sources;

    if (MINECRAFT.has(slug)) {
      const java = known.filter(({ file }) => /[\\/]javaw?\.exe$/i.test(file) && MINECRAFT_FOLDERS.test(file));
      const found = await nearestTop(java.filter(({ file }) => /javaw\.exe$/i.test(file)).map(({ file }) => file))
        || await nearestTop(java.map(({ file }) => file));
      if (found) return found;
    }

    // The process OBS captured. Unreal games run their real program deep in Binaries under the same
    // name, with a small one at the top whose icon is the game's.
    const keys = new Set(processes.map(programKey).filter(Boolean));
    if (keys.size) {
      const captured = await nearestTop(known.filter(({ file }) => keys.has(programKey(file))).map(({ file }) => file));
      if (captured) return captured;
    }

    const game = findGame(launchers, slug);
    if (game?.program && await isFile(game.program)) return game.program;
    const own = game?.dir ? await programsIn(game.dir) : [];
    const main = own.length ? mainProgram(own, game) : '';
    const named = (file, name = '') => sameGame(plainName(programKey(file)), slug) || sameGame(plainName(name), slug);
    if (main && named(main)) return main;

    // A program, or a window, named like the game, anywhere Windows saw it.
    const usableKnown = known.filter(({ file }) => usable(file));
    const byName = await nearestTop(usableKnown.filter(({ file, name }) => named(file, name)).map(({ file }) => file));
    if (byName) return byName;
    if (main) return main; // The launcher knows the folder, even when the program has another name.
    const folderNamed = usableKnown.filter(({ file }) => sameGame(plainName(path.basename(path.dirname(file))), slug));
    return nearestTop(folderNamed.map(({ file }) => file));
  }
}

module.exports = { Programs, rememberedPrograms, looseFolders };
