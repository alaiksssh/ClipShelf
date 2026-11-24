import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { UserGames, programKey } = require('../src/main/userGames');
const { gameFromProcess } = require('../src/main/games');
const { parseLog, captureInSession, ObsLogs } = require('../src/main/obsLogs');
const { installedGames, programsIn, mainProgram } = require('../src/main/launchers');
const { GameFolders, planMoves, preview, folderName } = require('../src/main/gameFolders');
const { GameIcons } = require('../src/main/gameIcons');
const { Library } = require('../src/main/library');

const store = (data = {}) => ({ data, save() {}, flush() {} });

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clipshelf-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const write = (file, content = '') => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    return path.join(dir, file);
  };
  return { dir, write };
}

test('added games name their programs, with the spelling the user gave', () => {
  const games = new UserGames(store());
  assert.equal(programKey('C:\\Riot Games\\VALORANT\\live\\VALORANT.exe'), 'valorant');
  assert.equal(programKey('VALORANT-Win64-Shipping.exe'), 'valorant');

  games.add({ name: 'Phantom Blade Zero', source: 'steam', programs: ['C:\\PBZ\\PBZ.exe', 'C:\\PBZ\\Game.exe'], program: 'C:\\PBZ\\PBZ.exe' });
  games.add({ name: 'My Browser Game', source: 'exe', program: 'D:\\Games\\chrome.exe' });
  games.add({ name: 'Game', source: 'exe', program: 'D:\\Indie\\Game.exe' });
  assert.equal(games.add({ name: 'phantom blade zero', source: 'list' }), 'Phantom Blade Zero'); // One game, not two.
  assert.equal(games.list().length, 3);

  assert.equal(games.byProgram('PBZ.exe'), 'Phantom Blade Zero');
  assert.equal(games.byProgram('PBZ-Win64-Shipping.exe'), 'Phantom Blade Zero');
  // "Game.exe" found in a folder names nothing, but picked by hand it names that game.
  assert.equal(games.byProgram('game.exe'), 'Game');
  assert.equal(games.spelling('PHANTOM BLADE ZERO'), 'Phantom Blade Zero');
  assert.equal(games.spelling('Unknown'), 'Unknown');
  assert.deepEqual(games.programOf('mybrowsergame'), { file: 'D:\\Games\\chrome.exe', picked: true });

  // A program the user added counts even when it is usually not a game.
  assert.equal(gameFromProcess('chrome.exe', 'New tab', games), 'My Browser Game');
  assert.equal(gameFromProcess('chrome.exe', 'New tab'), '');
  assert.equal(gameFromProcess('S-Game-Win64-Shipping.exe', 'PHANTOM BLADE ZERO', games), 'Phantom Blade Zero');
  assert.equal(gameFromProcess('cs2.exe', '', games), 'Counter-Strike 2');

  games.remove('My browser game');
  assert.equal(games.byProgram('chrome.exe'), '');
  assert.throws(() => games.add({ name: '  ', source: 'list' }));
  assert.throws(() => games.add({ name: 'X', source: 'web' }));
});

test('a game added after the OBS log was read names its clips', () => {
  const log = [
    "10:00:00.000: [game-capture: 'Jeu'] attempting to hook process: Indie.exe",
    "10:00:01.000: [game-capture: 'Jeu'] shared texture capture successful",
    '10:00:01.000: \texecutable: Indie.exe',
    '10:00:01.000: \ttitle: A very long window title that says nothing useful at all',
    "10:02:00.000: [ffmpeg muxer: 'Replay Buffer'] Wrote replay buffer to 'C:/Videos/indie.mp4'",
  ].join('\n');
  const settings = store();
  const games = new UserGames(settings);
  const logs = new ObsLogs('', games);
  logs.sessions.set('a', parseLog('2026-11-23 09-59-00.txt', log));

  assert.deepEqual(logs.captureFor('C:\\Videos\\indie.mp4', 30), { game: 'Indie', executable: 'Indie.exe' });
  games.add({ name: 'Indie Hero', source: 'exe', program: 'E:\\Indie\\Indie.exe' });
  assert.deepEqual(logs.captureFor('C:\\Videos\\indie.mp4', 30), { game: 'Indie Hero', executable: 'Indie.exe' });
  assert.equal(captureInSession(logs.sessions.get('a'), 'C:\\Videos\\other.mp4', 30), null);
});

test('clips read before take the name of a game added later, through their saved process', () => {
  const settings = store({ folders: [] });
  const games = new UserGames(settings);
  const meta = store({
    k1: { capturedGame: 'Indie', capturedProcess: 'Indie.exe' },
    k2: { capturedGame: 'Valorant' }, // Read by 1.5: the logs are asked once for its process.
  });
  let asked = 0;
  const obsLogs = { captureFor: () => { asked += 1; return { game: 'Valorant', executable: 'VALORANT-Win64-Shipping.exe' }; } };
  const library = new Library({ settings, meta, index: store(), obsLogs, games });
  assert.equal(library.capturedGame('a.mp4', { key: 'k1', duration: 30 }), 'Indie');
  games.add({ name: 'Indie Hero', source: 'exe', program: 'E:\\Indie\\Indie.exe' });
  assert.equal(library.capturedGame('a.mp4', { key: 'k1', duration: 30 }), 'Indie Hero');

  assert.equal(library.capturedGame('b.mp4', { key: 'k2', duration: 30 }), 'Valorant');
  assert.equal(library.capturedGame('b.mp4', { key: 'k2', duration: 30 }), 'Valorant');
  assert.equal(asked, 1);
  assert.equal(meta.data.k2.capturedProcess, 'VALORANT-Win64-Shipping.exe');
});

test('installed games come from Steam, Epic, Riot and Xbox, without their tools', async (t) => {
  const { dir, write } = temp(t, 'launchers');
  write('steam/steamapps/libraryfolders.vdf', `"libraryfolders" { "1" { "path" "${path.join(dir, 'lib2').replaceAll('\\', '\\\\')}" } }`);
  write('steam/steamapps/appmanifest_42.acf', '"name" "Phantom Blade Zero"\n"installdir" "PBZ"');
  write('steam/steamapps/appmanifest_228980.acf', '"name" "Steamworks Common Redistributables"\n"installdir" "Steamworks Shared"');
  write('lib2/steamapps/appmanifest_7.acf', '"name" "Trackmania"\n"installdir" "Trackmania"');
  write('lib2/steamapps/appmanifest_8.acf', '"name" "Proton 9.0"\n"installdir" "Proton 9.0"');
  write('pd/Epic/EpicGamesLauncher/Data/Manifests/a.item', JSON.stringify({ DisplayName: 'Fortnite', InstallLocation: path.join(dir, 'fn'), LaunchExecutable: 'FortniteLauncher.exe' }));
  write('pd/Riot Games/Metadata/valorant.live/valorant.live.product_settings.yaml', 'product_install_full_path: "C:/Riot Games/VALORANT/live"\n');
  write('pd/Riot Games/Metadata/bacon.live/bacon.live.lockfile'); // Not installed.
  write('xbox/Halo/Content/MicrosoftGame.config', '<Game><ShellVisuals DefaultDisplayName="Halo"/><ExecutableList><Executable Name="halo.exe"/></ExecutableList><DisplayName>Halo Infinite</DisplayName></Game>');
  write('xbox/GameSave/readme.txt');

  const games = await installedGames({
    env: { ProgramData: path.join(dir, 'pd') },
    findSteam: async () => path.join(dir, 'steam'),
    xboxRoots: [path.join(dir, 'xbox')],
  });
  assert.deepEqual(games.map(({ source, name }) => `${source}:${name}`),
    ['epic:Fortnite', 'xbox:Halo Infinite', 'steam:Phantom Blade Zero', 'steam:Trackmania', 'riot:Valorant']);
  assert.equal(games.find((game) => game.source === 'riot').dir, path.normalize('C:/Riot Games/VALORANT/live'));
  assert.equal(games.find((game) => game.source === 'xbox').program, path.join(dir, 'xbox', 'Halo', 'Content', 'halo.exe'));
});

test('the programs of a game folder, without installers and crash reporters', async (t) => {
  const { dir, write } = temp(t, 'programs');
  write('VALORANT/live/VALORANT.exe');
  write('VALORANT/live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe');
  write('VALORANT/live/Engine/Binaries/Win64/CrashReportClient.exe');
  write('VALORANT/live/Engine/Binaries/Win64/EpicWebHelper.exe');
  write('VALORANT/live/_CommonRedist/vcredist/vc_redist.x64.exe');
  write('VALORANT/live/unins000.exe');
  write('VALORANT/live/a/b/c/d/e/Deep.exe'); // Too deep to be worth the time.

  const programs = await programsIn(path.join(dir, 'VALORANT', 'live'));
  assert.deepEqual(programs.map((file) => path.basename(file)).sort(), ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe']);
  assert.equal(path.basename(mainProgram(programs, { name: 'Valorant', dir: path.join(dir, 'VALORANT', 'live') })), 'VALORANT.exe');
  assert.deepEqual(await programsIn(path.join(dir, 'missing')), []);
});

test('a program picked by hand gives the logo of its game', async (t) => {
  const { dir, write } = temp(t, 'program-logo');
  const program = write('Indie/Indie.exe', 'program');
  const games = new UserGames(store());
  const icons = new GameIcons({
    dir: path.join(dir, 'logos'),
    env: {},
    findSteam: async () => '',
    xboxRoots: [],
    programIcon: async (file) => ({ bytes: Buffer.from(`icon of ${path.basename(file)}`), extension: 'png' }),
    readShortcut: () => ({}),
    programOf: (slug) => games.programOf(slug),
  });
  await icons.refresh(['Indie Hero']);
  assert.equal(icons.fileOf('indiehero'), null);
  games.add({ name: 'Indie Hero', source: 'exe', program });
  await icons.renew('Indie Hero');
  assert.equal(fs.readFileSync(icons.fileOf('indiehero'), 'utf8'), 'icon of Indie.exe');
});

test('game folders have names Windows accepts', () => {
  assert.equal(folderName('Valorant'), 'Valorant');
  assert.equal(folderName('Call of Duty: Warzone'), 'Call of Duty Warzone');
  assert.equal(folderName('R.E.P.O.'), 'R.E.P.O');
  assert.equal(folderName('a/b\\c?'), 'a b c');
  assert.equal(folderName(''), 'Other');
  assert.equal(folderName('CON'), 'Other');
  assert.equal(folderName('...'), 'Other');
});

test('only settled clips of sorted folders move, and never exports or unreadable files', () => {
  const root = path.resolve('I:/Clips');
  const now = 10 * 60 * 1000;
  const clip = (id, file, more = {}) => ({
    id, key: `${id}-key`, path: path.join(root, file), root, mtime: 0, game: 'Valorant', size: 100, ...more,
  });
  const clips = [
    clip('a', 'a.mp4'),
    clip('b', 'valorant/b.mp4'), // Already there, whatever the case.
    clip('c', 'Replays/c.mp4', { game: '' }),
    clip('d', 'd.mp4', { busy: true }),
    clip('e', 'e.mp4', { broken: true }),
    clip('f', 'f.mp4', { exported: true }),
    clip('g', 'ClipShelf/g.mp4'),
    clip('h', 'h.mp4', { mtime: now - 5000 }),
    clip('i', 'i.mp4', { root: path.resolve('D:/Other root'), path: path.resolve('D:/Other root/i.mp4') }),
    clip('j', 'j.mp4', { game: 'Call of Duty: Warzone' }),
    clip('k', 'k.mp4'),
  ];
  const waiting = [];
  const moves = planMoves(clips, { roots: [root], exportDir: path.join(root, 'ClipShelf'), now, skip: new Set(['k']), waiting });
  assert.deepEqual(moves.map((move) => [move.id, path.relative(root, move.dir)]),
    [['a', 'Valorant'], ['c', 'Other'], ['j', 'Call of Duty Warzone']]);
  assert.deepEqual(waiting, [now - 5000 + 30000]);

  const plan = preview(clips, { root, exportDir: path.join(root, 'ClipShelf') });
  assert.equal(plan.moving, 5); // h and k count: they move later.
  assert.equal(plan.busy, 1);
  assert.equal(plan.broken, 1);
  assert.deepEqual(plan.games.map((row) => [row.game, row.count]), [['Valorant', 3], ['Other', 1], ['Call of Duty: Warzone', 1]]);
});

test('sorting moves files by game, follows game changes, and removes the folders it made once empty', async (t) => {
  const { dir, write } = temp(t, 'sorting');
  const old = Date.now() - 3600e3;
  const add = (library, file, game) => {
    const full = write(file, file);
    fs.utimesSync(full, old / 1000, old / 1000);
    const id = `id-${file}`;
    library.clips.set(id, { id, key: `key-${file}`, path: full, root: dir, mtime: old, name: path.parse(full).name, duration: 10, size: 1, audio: [], guessedGame: game, date: old });
    library.index.data[id] = { stamp: 'x', key: `key-${file}` };
    return id;
  };
  write('Valorant/b.mp4', 'already there with the same name');
  const settings = store({ folders: [dir], exportDir: path.join(dir, 'exports') });
  const meta = store();
  const library = new Library({ settings, meta, index: store(), obsLogs: {} });
  library.schedule = () => {}; // No real scans: the clips above are all there is.
  add(library, 'a.mp4', 'Valorant');
  add(library, 'b.mp4', 'Valorant');
  const busyId = add(library, 'c.mp4', 'Minecraft');
  const journal = [];
  let open = [busyId];
  const sorter = new GameFolders({ library, settings, journal: (from, to) => journal.push([from, to]), leave: () => open });
  t.after(() => sorter.stop());

  assert.deepEqual(await sorter.run(), { moved: 0, failed: [] }); // Off until the user turns it on.
  const result = await sorter.turn(dir, true);
  assert.equal(result.moved, 2);
  assert.ok(fs.existsSync(path.join(dir, 'Valorant', 'a.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'Valorant', 'b (2).mp4'))); // Nothing is ever replaced.
  assert.equal(fs.readFileSync(path.join(dir, 'Valorant', 'b.mp4'), 'utf8'), 'already there with the same name');
  assert.ok(fs.existsSync(path.join(dir, 'c.mp4'))); // Open in the editor.
  assert.equal(journal.length, 2);
  const moved = [...library.clips.values()].find((clip) => clip.name === 'a');
  assert.equal(library.index.data[moved.id].key, 'key-a.mp4'); // Not read again.
  assert.equal(library.get('id-a.mp4').id, moved.id); // What the page knew before the move still works.
  assert.deepEqual(settings.data.madeFolders, []); // "Valorant" was there before.

  open = [];
  await sorter.run();
  assert.ok(fs.existsSync(path.join(dir, 'Minecraft', 'c.mp4')));
  assert.deepEqual(settings.data.madeFolders, [path.join(dir, 'Minecraft')]);

  // Its game changes: it follows, and the folder ClipShelf made goes.
  const c = [...library.clips.values()].find((clip) => clip.name === 'c');
  meta.data[c.key] = { game: 'Terraria' };
  await sorter.run();
  assert.ok(fs.existsSync(path.join(dir, 'Terraria', 'c.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'Minecraft')));

  // A file another program holds stays, and is tried again later.
  write('d.mp4');
  const d = add(library, 'd.mp4', 'Valorant');
  const move = library.move.bind(library);
  library.move = async (id, ...rest) => {
    if (id === d) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return move(id, ...rest);
  };
  const busy = await sorter.run();
  assert.equal(busy.failed.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'd.mp4')));
  assert.ok(sorter.timer); // Tried again later.
  assert.deepEqual(await sorter.run(), { moved: 0, failed: [] }); // Not hammered meanwhile.

  await sorter.turn(dir, false);
  assert.deepEqual(settings.data.sortRoots, []);
});

test('the clip open in the editor stays in place, even once renamed', async (t) => {
  const { dir, write } = temp(t, 'sorting-open');
  const file = write('clip.mp4', 'clip');
  const old = Date.now() - 3600e3;
  fs.utimesSync(file, old / 1000, old / 1000);
  const settings = store({ folders: [dir], sortRoots: [dir] });
  const library = new Library({ settings, meta: store(), index: store(), obsLogs: {} });
  library.schedule = () => {};
  library.clips.set('first', { id: 'first', key: 'k', path: file, root: dir, mtime: old, name: 'clip', duration: 10, size: 1, audio: [], guessedGame: 'Valorant', date: old });
  const sorter = new GameFolders({ library, settings, leave: () => ['first'] });
  t.after(() => sorter.stop());

  const renamed = await library.rename('first', 'best');
  assert.notEqual(renamed, 'first');
  assert.deepEqual(await sorter.run(), { moved: 0, failed: [] });
  assert.ok(fs.existsSync(path.join(dir, 'best.mp4')));
});
