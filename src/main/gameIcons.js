// Logos of games, taken from what is installed on this PC: the icon of the program of the game, then the
// pictures of Riot, Steam, the Xbox app, Epic and the Start menu. Steam keeps the pictures of every game
// of the account, installed or not. Nothing is downloaded. A logo chosen by hand comes first.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { grassBlock } = require('./blockIcon');
const { exeIcon } = require('./exeIcon');
const { readAppInfo } = require('./steamAppInfo');
const path = require('node:path');
const { t } = require('./i18n');
const {
  plainName, findGame, steamPath, steamApps, xboxFolders, xboxGames, epicGames,
} = require('./launchers');

const MAX_BYTES = 4 * 1024 * 1024;
const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'ico'];
const STEAM_ICON = /^[0-9a-f]{40}\.jpg$/i;
// Logos made before 1.7 put launcher pictures before the icon of the program: they are made again.
const AUTO = 'auto2';
const OLD_AUTO = 'auto';

const XBOX_LOGOS = ['SmallLogo.altform-unplated_targetsize-256.png', 'SmallLogo.targetsize-256.png', 'GraphicsLogo.png',
  'SmallLogo.scale-400.png', 'StoreLogo.png', 'SmallLogo.png'];

const fileId = (slug) => createHash('sha1').update(slug).digest('hex').slice(0, 20);

const entries = (dir, options) => fs.readdir(dir, options).catch(() => []);
const readText = (file) => fs.readFile(file, 'utf8').catch(() => '');
const isImage = (file) => IMAGES.includes(path.extname(file).slice(1).toLowerCase());

/** The shortcuts of the Start menu and of the desktops: plain name -> file. */
async function shortcuts(dirs) {
  const found = new Map();
  for (const [dir, recursive] of dirs) {
    for (const name of await entries(dir, { recursive })) {
      if (!/\.(lnk|url)$/i.test(name)) continue;
      const slug = plainName(path.parse(name).name);
      if (!found.has(slug)) found.set(slug, path.join(dir, name));
    }
  }
  return found;
}

/**
 * `programIcon(file)` resolves to the { bytes, extension } icon of a program, or null.
 * `readShortcut(file)` returns the { target, icon } of a .lnk.
 * `programOf(slug, again)` gives, or resolves to, the { file, picked } program of a game, or null.
 * With `again`, a program that was found before is looked for again.
 */
class GameIcons {
  constructor({
    dir, programIcon = exeIcon, readShortcut, decodePng, encodePng, env = process.env, findSteam = steamPath,
    xboxRoots = xboxFolders(), programOf = () => null,
  }) {
    Object.assign(this, { dir, programIcon, readShortcut, decodePng, encodePng, env, findSteam, xboxRoots, programOf });
    this.found = new Map(); // slug -> { file, version }, or null without a logo
    this.again = new Set(); // Games whose program is looked for again.
    this.sources = null;
    this.pending = Promise.resolve();
  }

  /** Resolves to true when a logo appeared. */
  refresh(names) {
    const job = this.pending.then(() => this.add(names));
    this.pending = job.catch(() => {});
    return job;
  }

  async add(names) {
    let changed = false;
    for (const slug of new Set(names.map(plainName))) {
      if (!slug || this.found.has(slug)) continue;
      const file = await this.resolve(slug).catch((error) => {
        console.error(`No logo for ${slug}:`, error.message);
        return null;
      });
      const value = file && { file, version: Math.round((await fs.stat(file)).mtimeMs) };
      this.found.set(slug, value);
      changed ||= Boolean(value);
    }
    return changed;
  }

  /** { [slug]: version }, for the page. */
  list() {
    return Object.fromEntries([...this.found].filter(([, logo]) => logo).map(([slug, logo]) => [slug, logo.version]));
  }

  fileOf(slug) {
    return this.found.get(slug)?.file ?? null;
  }

  async saved(slug, kind) {
    for (const extension of IMAGES) {
      const file = path.join(this.dir, `${fileId(slug)}-${kind}.${extension}`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  async keep(slug, kind, { bytes, extension }) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${fileId(slug)}-${kind}.${extension}`);
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, file);
    return file;
  }

  async resolve(slug) {
    const kept = await this.saved(slug, 'custom') || await this.saved(slug, AUTO);
    if (kept) return kept;
    await this.forget(slug, OLD_AUTO);
    this.sources ??= this.scanSources();
    const sources = await this.sources;
    // The icon of the program is what the user sees in the taskbar while playing. Minecraft runs in
    // Java, whose icon is a cup: its grass block stands for it. Launcher pictures are for games
    // whose program is not found or has no icon.
    const program = await this.programOf(slug, this.again.delete(slug));
    const image = await this.fromMinecraft(slug) || await this.image(program?.file)
      || await this.fromRiot(slug) || await this.fromSteam(slug, sources) || await this.fromXbox(slug, sources)
      || await this.fromEpic(slug, sources) || await this.fromShortcut(slug, sources);
    return image ? this.keep(slug, AUTO, image) : null;
  }

  async scanSources() {
    const { APPDATA = '', ProgramData = '', USERPROFILE = '', PUBLIC = '' } = this.env;
    const menu = ['Microsoft', 'Windows', 'Start Menu', 'Programs'];
    const steam = await this.findSteam();
    const known = await readAppInfo(steam);
    const steamNames = new Map();
    for (const game of known) if (!steamNames.has(plainName(game.name))) steamNames.set(plainName(game.name), game);
    return {
      steam,
      apps: await steamApps(steam),
      steamInfo: new Map(known.map((game) => [game.id, game])),
      steamNames,
      xbox: await xboxGames(this.xboxRoots),
      epic: await epicGames(path.join(ProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')),
      links: await shortcuts([
        [path.join(APPDATA, ...menu), true],
        [path.join(ProgramData, ...menu), true],
        [path.join(USERPROFILE, 'Desktop'), false],
        [path.join(PUBLIC, 'Desktop'), false],
      ]),
    };
  }

  async image(file) {
    if (!file || !path.isAbsolute(file) || file.startsWith('\\\\')) return null; // Local files only.
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    if (isImage(file)) {
      if (stat.size > MAX_BYTES) return null;
      return { bytes: await fs.readFile(file), extension: path.extname(file).slice(1).toLowerCase() };
    }
    if (path.extname(file).toLowerCase() !== '.exe') return null;
    const icon = await this.programIcon(file).catch(() => null);
    return icon?.bytes?.length ? icon : null;
  }

  async fromRiot(slug) {
    const root = path.join(this.env.ProgramData || '', 'Riot Games', 'Metadata');
    for (const product of await entries(root)) {
      if (!product.endsWith('.live') || plainName(product.slice(0, -'.live'.length)) !== slug) continue;
      const icon = await this.image(path.join(root, product, `${product}.ico`));
      if (icon) return icon;
    }
    return null;
  }

  /** Minecraft is better known by its grass block than by the logo of its launcher or of Java. */
  async fromMinecraft(slug) {
    if (!['minecraft', 'minecraftjavaedition'].includes(slug) || !this.decodePng) return null;
    const { APPDATA = '', USERPROFILE = '' } = this.env;
    const folders = [
      path.join(APPDATA, '.minecraft', 'versions'),
      path.join(APPDATA, 'ModrinthApp', 'meta', 'versions'),
      path.join(USERPROFILE, 'curseforge', 'minecraft', 'Install', 'versions'),
      path.join(APPDATA, 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft'),
    ];
    const jars = [];
    for (const folder of folders) {
      for (const version of await entries(folder)) {
        for (const name of await entries(path.join(folder, version))) {
          if (name.endsWith('.jar')) jars.push(path.join(folder, version, name));
        }
      }
    }
    const bytes = await grassBlock(jars.sort().reverse(), this);
    return bytes ? { bytes, extension: 'png' } : null;
  }

  async fromXbox(slug, { xbox }) {
    const game = findGame(xbox, slug);
    if (!game) return null;
    for (const name of [...XBOX_LOGOS, ...game.declared]) {
      const icon = await this.image(path.join(game.dir, name));
      if (icon) return icon;
    }
    return null;
  }

  async fromEpic(slug, { epic }) {
    const game = findGame(epic, slug);
    return game ? this.image(game.program) : null;
  }

  async fromSteam(slug, { steam, apps, steamInfo, steamNames }) {
    // An uninstalled game has no manifest, but Steam still knows it and keeps its pictures.
    const app = findGame(apps, slug) || findGame(steamNames, slug);
    if (!app) return null;
    const info = steamInfo.get(app.id) || {};
    const cache = path.join(steam, 'appcache', 'librarycache', app.id);
    const names = await entries(cache);
    const small = names.find((name) => name.toLowerCase() === `${info.icon}.jpg`)
      || names.find((name) => STEAM_ICON.test(name));
    // The large icon is the one Steam gives desktop shortcuts. Its hash is `clienticon` in appinfo.vdf;
    // some games keep it under the hash of the small one.
    for (const hash of new Set([info.clienticon, small && path.parse(small).name.toLowerCase()])) {
      const large = hash && await this.image(path.join(steam, 'steam', 'games', `${hash}.ico`));
      if (large) return large;
    }
    if (app.dir) {
      const programs = (await entries(app.dir)).filter((name) => /\.exe$/i.test(name));
      const named = programs.find((name) => [slug, plainName(path.basename(app.dir))].includes(plainName(path.parse(name).name)));
      const icon = named && await this.image(path.join(app.dir, named));
      if (icon) return icon;
    }
    return small ? this.image(path.join(cache, small)) : null;
  }

  async fromShortcut(slug, { links }) {
    const link = findGame(links, slug);
    if (!link) return null;
    if (/\.url$/i.test(link)) return this.image((await readText(link)).match(/^IconFile=(.+?)\r?$/m)?.[1]);
    try {
      const { target, icon } = this.readShortcut(link);
      return await this.image(icon) || await this.image(target);
    } catch {
      return null; // Not every shortcut points to a file.
    }
  }

  async choose(name, source) {
    const slug = plainName(name);
    if (!slug) throw new Error(t('logo.noGame'));
    if (!isImage(source)) throw new Error(t('logo.type'));
    const image = await this.image(source);
    if (!image) throw new Error(t('logo.bad'));
    await this.forget(slug, 'custom');
    await this.keep(slug, 'custom', image);
    await this.reload(slug);
  }

  /** The logo is made again, and the program of the game looked for again: it may have moved. */
  async automatic(name) {
    const slug = plainName(name);
    if (!slug) return;
    await this.forget(slug, 'custom');
    await this.forget(slug, AUTO);
    this.again.add(slug);
    this.sources = null; // The game may have been installed meanwhile.
    await this.reload(slug);
  }

  /** After a game is added: its program gives the logo. */
  async renew(name) {
    const slug = plainName(name);
    if (!slug) return;
    await this.forget(slug, AUTO);
    this.sources = null;
    await this.reload(slug);
  }

  /** Removes only the copies made by ClipShelf in its own folder. */
  async forget(slug, kind) {
    for (let file; (file = await this.saved(slug, kind));) await fs.rm(file);
  }

  async reload(slug) {
    this.found.delete(slug);
    await this.refresh([slug]);
  }
}

module.exports = { GameIcons, plainName, IMAGES };
