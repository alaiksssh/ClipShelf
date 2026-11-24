import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../src/shared/pieces.mjs';
import { createEdit } from '../src/shared/edit.mjs';
import { placeMoments, carryMoments, carryTime, mergeDetected, countMoments, labelOf, roundOf, placeRounds, carryRounds, multiKill, MARK_COLORS } from '../src/shared/moments.mjs';
import { translator } from '../src/shared/i18n.mjs';

const { t: french } = translator('fr');
import { gameChoices, OTHER } from '../src/shared/gameList.mjs';
import { searcher } from '../src/shared/search.mjs';

const require = createRequire(import.meta.url);
const { Organizer } = require('../src/main/organizer');
const { Detector } = require('../src/main/detector');
const { GameIcons, plainName } = require('../src/main/gameIcons');
const { Library } = require('../src/main/library');

const store = (data = {}) => ({ data, save() {}, flush() {} });

function setup(metaData = {}) {
  const library = new Library({ settings: store({ folders: [] }), meta: store(metaData), index: store(), obsLogs: {} });
  const add = (id, more = {}) => library.clips.set(id, {
    id, key: `${id}-key`, name: id, path: `${id}.mp4`, duration: 60, date: 1, audio: [], guessedGame: 'Valorant', ...more,
  });
  return { library, add, settings: store() };
}

const MOMENTS = [
  { id: 1, kind: 'kill', time: 5, name: '' },
  { id: 2, kind: 'kill', time: 25, name: 'Flick' },
  { id: 3, kind: 'death', time: 50, name: '' },
];

test('moments follow cuts, speed and copies', () => {
  let { pieces } = createEdit({ duration: 60, audio: [{}] });
  pieces = P.rippleDelete(pieces, [0, 20]);
  assert.deepEqual(placeMoments(MOMENTS, pieces).map((m) => [m.id, m.at]), [[2, 5], [3, 30]]);
  assert.equal(labelOf(placeMoments(MOMENTS, pieces)[1], french), 'Mort 1');

  const fast = P.setSpeed(pieces, pieces.find((p) => p.lane === P.VIDEO).id, 2, { linked: true, ripple: true });
  assert.deepEqual(placeMoments(MOMENTS, fast).map((m) => m.at), [2.5, 15]);

  const twice = P.insert(pieces, P.copySpan(pieces, [0, 10]), 40, 10).pieces;
  assert.deepEqual(placeMoments(MOMENTS, twice).map((m) => [m.id, m.at]), [[2, 5], [3, 30], [2, 45]]);
});

test('kills keep their number when the first is cut away', () => {
  const { pieces } = createEdit({ duration: 60, audio: [] });
  assert.equal(labelOf(placeMoments([MOMENTS[0], { ...MOMENTS[1], name: '' }], P.rippleDelete(pieces, [0, 20]))[0], french), 'Kill 2');
});

test('saving a montage carries its moments and their names', () => {
  const { pieces } = createEdit({ duration: 60, audio: [] });
  assert.deepEqual(carryMoments(MOMENTS, P.rippleDelete(pieces, [0, 20])), [
    { id: 1, kind: 'kill', time: 5, name: 'Flick' },
    { id: 2, kind: 'death', time: 30, name: '' },
  ]);
});

test('detecting again keeps marks and names', () => {
  const previous = [...MOMENTS, { id: 4, kind: 'mark', time: 12, name: 'Début' }];
  const merged = mergeDetected(previous, [{ kind: 'kill', time: 24.5 }, { kind: 'kill', time: 40 }]);
  assert.deepEqual(merged.map((m) => [m.kind, m.time, m.name]), [['mark', 12, 'Début'], ['kill', 24.5, 'Flick'], ['kill', 40, '']]);
  assert.deepEqual(countMoments(merged), { kill: 2, death: 0, mark: 1, best: 2 });
});

test('the search reads names, tags, categories and moments', () => {
  const clip = { name: 'Replay 13', title: 'Clutch de fou', game: 'Valorant', category: 'À monter', tags: ['ace', 'drôle'], moments: MOMENTS };
  const found = (query) => searcher(query)(clip);
  for (const query of ['clutch', 'CLUTCH fou', 'valo', 'a monter', '#drole', '#ac', 'flick', 'kill', 'mort', '2k', '', '  ', '#']) {
    assert.ok(found(query), query);
  }
  for (const query of ['#clutch', '3k', 'clutch overwatch']) assert.ok(!found(query), query);
});

test('names, categories and tags', () => {
  const { library, add, settings } = setup();
  add('a');
  add('b');
  const organizer = new Organizer({ library, settings });
  assert.equal(organizer.addCategory('  Best   of '), 'Best of');
  assert.equal(organizer.addCategory('best OF'), 'Best of');
  assert.throws(() => organizer.addCategory('  '));

  library.update(['a', 'b'], { category: 'Best of', title: ' Mon  clip ', addTags: ['#ACE', 'Drôle', ''] });
  let [clip] = library.list();
  assert.deepEqual([clip.category, clip.title, clip.tags], ['Best of', 'Mon clip', ['ace', 'drôle']]);

  organizer.renameCategory('Best of', 'Top');
  assert.deepEqual(organizer.categories(), ['Top']);
  assert.ok(library.list().every((c) => c.category === 'Top'));

  organizer.renameTag('drôle', 'ace'); // Merges.
  assert.deepEqual(library.list()[0].tags, ['ace']);
  library.update(['a'], { removeTags: ['ace'], title: '' });
  [clip] = library.list();
  assert.deepEqual([clip.tags, clip.title], [[], '']);

  assert.equal(organizer.addTag(' #Keenan '), 'keenan');
  assert.deepEqual(organizer.createdTags(), ['keenan']);
  organizer.renameTag('keenan', 'kee');
  assert.deepEqual(organizer.createdTags(), ['kee']);
  organizer.removeTag('kee');
  assert.deepEqual(organizer.createdTags(), []);
  library.update(['a'], { hideTallies: true });
  assert.equal(library.list().find((c) => c.id === 'a').hideTallies, true);
  organizer.removeCategory('Top');
  assert.deepEqual(organizer.categories(), []);
  assert.ok(library.list().every((c) => !c.category));
});

test('marks can be added, named and removed', () => {
  const { library, add, settings } = setup();
  add('a');
  const organizer = new Organizer({ library, settings });
  const id = organizer.editMoments('a', { add: { time: 12 } });
  const [added] = library.list()[0].moments;
  assert.equal(added.name, ''); // No name until one is given.
  assert.equal(labelOf({ moment: added, number: 1 }), '');
  assert.ok(MARK_COLORS.includes(added.color));
  organizer.editMoments('a', { name: { id, value: ' Flick ' } });
  organizer.editMoments('a', { color: { id, value: 'violet' } });
  assert.deepEqual(library.list()[0].moments, [{ id, kind: 'mark', time: 12, name: 'Flick', color: 'violet' }]);
  assert.throws(() => organizer.editMoments('a', { color: { id, value: 'red; background:url(x)' } }));
  // Two marks in a row never get the same colour.
  for (let i = 0; i < 30; i += 1) organizer.editMoments('a', { add: { time: 13 + i } });
  const colors = library.list()[0].moments.map((m) => m.color);
  assert.ok(colors.every((color, i) => !i || color !== colors[i - 1]));
  assert.ok(new Set(colors).size >= 4);
  for (const m of library.list()[0].moments.filter((x) => x.id !== id)) organizer.editMoments('a', { remove: m.id });
  assert.throws(() => organizer.editMoments('a', { add: { time: 61 } }));
  organizer.editMoments('a', { remove: id });
  assert.deepEqual(library.list()[0].moments, []);
});

test('the detector reads only Valorant, one clip at a time, the open one first', async () => {
  const { library, add } = setup();
  add('old', { date: 1 });
  add('new', { date: 3 });
  add('open', { date: 2 });
  add('other', { guessedGame: 'STRAFTAT' });
  add('writing', { busy: true });

  const order = [];
  let running = 0;
  const detector = new Detector({
    library,
    enabled: () => true,
    read: async (clip) => {
      running += 1;
      assert.equal(running, 1);
      order.push(clip.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { replay: false, events: [{ kind: 'kill', time: 4 }] };
    },
  });
  detector.prefer('open');
  while (detector.current) await detector.current.done;
  assert.deepEqual(order, ['open', 'new', 'old']);
  const list = library.list();
  assert.equal(list.filter((clip) => clip.detected && clip.moments.length === 1).length, 3);
  assert.equal(list.find((clip) => clip.id === 'other').detected, false);
});

test('changing a file waits until the detector let go of it', async () => {
  const { library, add } = setup();
  add('a');
  let reading = false;
  let reads = 0;
  const detector = new Detector({
    library,
    enabled: () => true,
    read: (clip, { signal }) => {
      reads += 1;
      if (reads > 1) return Promise.resolve({ replay: false, events: [] });
      reading = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => setTimeout(() => {
          reading = false;
          reject(new Error('stopped'));
        }, 20));
      });
    },
  });
  detector.pump();
  await detector.withFilesFree(async () => assert.equal(reading, false));
  while (detector.current) await detector.current.done;
  assert.equal(reads, 2); // And read again afterwards.
  assert.equal(library.list()[0].detected, true);
});

test('a detector that is switched off reads nothing', () => {
  const { library, add } = setup();
  add('a');
  const detector = new Detector({ library, enabled: () => false, read: () => assert.fail('read') });
  detector.prefer('a');
  assert.deepEqual(detector.status(), { id: null, left: 0 });
});

test('logos are the icons of the programs, then pictures of launchers, a chosen one first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-logos-'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const hash = 'a'.repeat(40);
  write('pd/Riot Games/Metadata/valorant.live/valorant.live.ico', 'riot');
  write('steam/steamapps/appmanifest_42.acf', '"name" "Phantom Blade Zero"\n"installdir" "PBZ"');
  write(`steam/appcache/librarycache/42/${hash}.jpg`, 'small');
  write(`steam/steam/games/${hash}.ico`, 'large');
  write('mine.png', 'mine');
  write('xbox/Minecraft Launcher/Content/appxmanifest.xml', '<Package><Properties><DisplayName>Minecraft Launcher</DisplayName></Properties><VisualElements Square150x150Logo="GraphicsLogo.png"/></Package>');
  write('xbox/Minecraft Launcher/Content/GraphicsLogo.png', 'creeper');
  write('pd/Epic/EpicGamesLauncher/Data/Manifests/a.item', JSON.stringify({ DisplayName: 'Fortnite', InstallLocation: path.join(root, 'fn'), LaunchExecutable: 'Fortnite.exe' }));
  write('fn/Fortnite.exe', 'program');
  write('pbz/PBZ.exe', 'program');
  write('pd/Riot Games/Metadata/teamfighttactics.live/teamfighttactics.live.ico', 'tft');
  write('tft/TFT.exe', 'no icon inside');
  // A logo made by an older release, when launcher pictures came first.
  write(`logos/${createHash('sha1').update('teamfighttactics').digest('hex').slice(0, 20)}-auto.ico`, 'old');

  try {
    const icons = new GameIcons({
      dir: path.join(root, 'logos'),
      env: { ProgramData: path.join(root, 'pd') },
      findSteam: async () => path.join(root, 'steam'),
      readShortcut: () => ({}),
      xboxRoots: [path.join(root, 'xbox')],
      programIcon: async (file) => (/(Fortnite|PBZ)\.exe$/.test(file)
        ? { bytes: Buffer.from(`${path.basename(file)} icon`), extension: 'png' }
        : null),
      programOf: async (slug, again) => {
        asked.push([slug, again]);
        const file = { phantombladezero: 'pbz/PBZ.exe', teamfighttactics: 'tft/TFT.exe' }[slug];
        return file ? { file: path.join(root, file), picked: false } : null;
      },
    });
    const read = (name) => fs.readFileSync(icons.fileOf(plainName(name)), 'utf8');
    const asked = [];

    assert.equal(await icons.refresh(['Valorant', 'VALORANT', 'Phantom Blade Zero', 'Unknown', '']), true);
    assert.equal(read('Valorant'), 'riot');
    assert.equal(read('Phantom Blade Zero'), 'PBZ.exe icon'); // Its program wins over Steam's picture.
    assert.equal(icons.fileOf('unknown'), null);
    await icons.refresh(['Minecraft', 'Fortnite', 'Craft']);
    assert.equal(read('Minecraft'), 'creeper'); // Installed as "Minecraft Launcher" by the Xbox app.
    assert.equal(read('Fortnite'), 'Fortnite.exe icon');
    await icons.refresh(['Teamfight Tactics']);
    assert.equal(read('Teamfight Tactics'), 'tft'); // Its program has no icon: Riot's picture is made again.
    assert.ok(!fs.readdirSync(path.join(root, 'logos')).some((name) => name.endsWith('-auto.ico')));
    assert.equal(icons.fileOf('craft'), null); // A part of a name is not the name.
    assert.equal(icons.fileOf('../../mine.png'), null);

    await icons.choose('Valorant', path.join(root, 'mine.png'));
    assert.equal(read('Valorant'), 'mine');
    asked.length = 0;
    await icons.automatic('Valorant');
    assert.equal(read('Valorant'), 'riot');
    assert.deepEqual(asked, [['valorant', true]]); // Its program is looked for again.
    await assert.rejects(icons.choose('Valorant', path.join(root, 'pd')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kills are counted per round', () => {
  const kills = [5, 10, 40, 42, 44, 70].map((time, i) => ({ id: i + 1, kind: 'kill', time, name: '' }));
  assert.equal(countMoments(kills, [30, 60]).best, 3);
  assert.equal(countMoments(kills, []).best, 6); // One round.
  assert.equal(countMoments(kills, null).best, 6); // No rounds, as in Deathmatch.
  assert.deepEqual([roundOf(10, [30, 60]), roundOf(30, [30, 60]), roundOf(65, [30, 60]), roundOf(65, null)], [1, 2, 3, null]);
  assert.deepEqual([multiKill(1), multiKill(3), multiKill(5), multiKill(7)], ['', '3K', 'ACE', 'ACE']);
  assert.ok(searcher('3k')({ name: 'a', game: '', category: '', tags: [], moments: kills, rounds: [30, 60] }));
  assert.ok(!searcher('4k')({ name: 'a', game: '', category: '', tags: [], moments: kills, rounds: [30, 60] }));
});

test('round starts follow the montage', () => {
  const { pieces } = createEdit({ duration: 90, audio: [] });
  const cut = P.rippleDelete(pieces, [20, 50]);
  assert.deepEqual(placeRounds([30, 60], cut), [{ at: 30, number: 3 }]);
  assert.deepEqual(carryRounds([30, 60], cut), [30]);
  assert.equal(carryRounds(null, cut), null);
});

test('the list of games puts the library first, once, and ends with Other', () => {
  const choices = gameChoices(['VALORANT', 'Mon jeu', '']);
  assert.deepEqual(choices.slice(0, 2), ['VALORANT', 'Mon jeu']);
  assert.ok(!choices.includes('Valorant') && choices.length > 150);
  assert.equal(choices.at(-1), OTHER);
});

test('the grass block is the flat side texture inside a game file, kept sharp', async () => {
  const { grassBlock, SIDE } = require('../src/main/blockIcon');
  const zlib = await import('node:zlib');
  // A zip with one stored and one deflated entry, as jars have. Each pixel of the texture holds its column.
  const texture = Buffer.from(Array.from({ length: 16 * 16 * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) % 16)));
  const entries = [['assets/minecraft/textures/block/dirt.png', Buffer.from('dirt'), 0], [SIDE, texture, 8]];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, raw, method] of entries) {
    const data = method ? zlib.deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, Buffer.from(name), data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, Buffer.from(name));
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-jar-'));
  const jar = path.join(dir, 'game.jar');
  fs.writeFileSync(jar, Buffer.concat([...locals, directory, end]));
  try {
    let drawn = null;
    const bytes = await grassBlock([path.join(dir, 'missing.jar'), jar], {
      decodePng: (data) => ({ width: 16, height: 16, data }),
      encodePng: (image) => {
        drawn = image;
        return Buffer.from('png');
      },
    });
    assert.equal(String(bytes), 'png');
    assert.deepEqual([drawn.width, drawn.height], [256, 256]);
    const at = (x, y) => [...drawn.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    // Each pixel of the texture becomes a square of 16 by 16, without blur between them.
    assert.deepEqual([at(0, 0), at(15, 200), at(16, 0), at(255, 255)], [[0, 0, 0, 255], [0, 0, 0, 255], [1, 1, 1, 255], [15, 15, 15, 255]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the zone is what is played, exported and saved', async () => {
  const { zoneOf, outputEdit, loadEdit } = await import('../src/shared/edit.mjs');
  const clip = { duration: 31.98, audio: [{}] };
  const edit = { ...createEdit(clip), zone: [2.98, 21.52] };
  assert.deepEqual(zoneOf(edit), [2.98, 21.52]);
  const out = outputEdit(edit);
  assert.equal(out.zone, null);
  assert.ok(Math.abs(P.totalLength(out.pieces) - 18.54) < 1e-6);
  const picture = out.pieces.find((p) => p.lane === P.VIDEO);
  assert.deepEqual([picture.at, picture.from], [0, 2.98]);
  assert.equal(out.pieces.length, 2); // Sound stays with the picture.
  assert.equal(zoneOf({ ...edit, zone: [0, 31.98] }), null); // All of it is no zone.
  assert.deepEqual(zoneOf({ ...edit, zone: [10, 50] }), [10, 31.98]); // Kept inside the montage.
  assert.deepEqual(loadEdit({ ...edit, version: 2 }, clip).zone, [2.98, 21.52]);
  assert.equal(loadEdit({ ...edit, version: 2, zone: [5, 'x'] }, clip).zone, null);
  assert.equal(outputEdit({ ...edit, zone: null }).pieces, edit.pieces);
});

test('the chosen picture follows a saved montage, and goes when it is cut away', () => {
  const { pieces } = createEdit({ duration: 60, audio: [] });
  const cut = P.rippleDelete(pieces, [0, 20]);
  assert.equal(carryTime(25, cut), 5);
  assert.equal(carryTime(10, cut), undefined);
  assert.equal(carryTime(undefined, cut), undefined);
  const fast = P.setSpeed(cut, cut.find((p) => p.lane === P.VIDEO).id, 2, { linked: true, ripple: true });
  assert.equal(carryTime(50, fast), 15);
});

test('a chosen picture is kept per clip, shown in the list, and removed on request', () => {
  const { library, add } = setup();
  add('a');
  add('b');
  library.update(['a'], { thumb: 12.5 });
  library.update(['b'], { thumb: -3 });
  const shown = (id) => library.list().find((clip) => clip.id === id).thumb;
  assert.equal(shown('a'), 12.5);
  assert.equal(shown('b'), null);
  library.update(['a'], { thumb: null });
  assert.equal(shown('a'), null);
  assert.equal('thumb' in library.meta.data['a-key'] && library.meta.data['a-key'].thumb !== undefined, false);
});

test('each chosen picture has a cache file of its own, inside the clip', () => {
  const { Derived } = require('../src/main/derived');
  const derived = new Derived(os.tmpdir());
  const clip = { key: 'k', duration: 20 };
  assert.deepEqual(derived.thumbOf(clip, null), { time: 8, name: 'k-thumb.jpg' });
  assert.deepEqual(derived.thumbOf(clip, 3.25), { time: 3.25, name: 'k-thumb-3250.jpg' });
  assert.deepEqual(derived.thumbOf(clip, 99), { time: 19.75, name: 'k-thumb-19750.jpg' });
});
