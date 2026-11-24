import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { exeIcon } = require('../src/main/exeIcon');
const { Programs } = require('../src/main/programs');
const { UserGames } = require('../src/main/userGames');

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

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A 64-bit program with only a resource section, holding one icon group made of `images`
 * ([{ width, bytes }]). Without images, the program has no icon.
 */
function fakeExe(images) {
  const RVA = 0x1000;
  const RAW = 0x200;
  let rsrc = Buffer.alloc(32); // The root, written last.
  const add = (buffer) => {
    const at = rsrc.length;
    rsrc = Buffer.concat([rsrc, buffer]);
    return at;
  };
  const directory = (entries) => {
    const buffer = Buffer.alloc(16 + entries.length * 8);
    buffer.writeUInt16LE(entries.length, 14);
    entries.forEach(([id, target, folder], i) => {
      buffer.writeUInt32LE(id, 16 + i * 8);
      buffer.writeUInt32LE((folder ? 0x80000000 : 0) + target, 20 + i * 8);
    });
    return buffer;
  };
  const resource = (bytes) => {
    const at = add(bytes);
    const record = Buffer.alloc(16);
    record.writeUInt32LE(RVA + at, 0);
    record.writeUInt32LE(bytes.length, 4);
    return add(directory([[0x409, add(record), false]])); // One language.
  };

  if (images.length) {
    const icons = add(directory(images.map((image, i) => [i + 1, resource(image.bytes), true])));
    const group = Buffer.alloc(6 + images.length * 14);
    group.writeUInt16LE(1, 2);
    group.writeUInt16LE(images.length, 4);
    images.forEach((image, i) => {
      const at = 6 + i * 14;
      group[at] = image.width % 256;
      group[at + 1] = image.width % 256;
      group.writeUInt16LE(1, at + 4);
      group.writeUInt16LE(32, at + 6);
      group.writeUInt32LE(image.bytes.length, at + 8);
      group.writeUInt16LE(i + 1, at + 12);
    });
    const groups = add(directory([[1, resource(group), true]]));
    directory([[3, icons, true], [14, groups, true]]).copy(rsrc, 0);
  } else {
    directory([[16, add(directory([])), true]]).copy(rsrc, 0); // Only a version.
  }

  const head = Buffer.alloc(RAW);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(64, 60);
  head.write('PE\0\0', 64, 'latin1');
  head.writeUInt16LE(1, 64 + 6); // One section.
  head.writeUInt16LE(240, 64 + 20); // Size of the optional header.
  const optional = 64 + 24;
  head.writeUInt16LE(0x20b, optional);
  head.writeUInt32LE(RVA, optional + 128); // Resources: the third data directory.
  head.writeUInt32LE(rsrc.length, optional + 132);
  const section = optional + 240;
  head.write('.rsrc', section, 'latin1');
  head.writeUInt32LE(rsrc.length, section + 8);
  head.writeUInt32LE(RVA, section + 12);
  head.writeUInt32LE(rsrc.length, section + 16);
  head.writeUInt32LE(RAW, section + 20);
  return Buffer.concat([head, rsrc]);
}

test('the icon of a program is read from its resources, at its largest size', async (t) => {
  const { write } = temp(t, 'exe-icon');
  const png = Buffer.concat([PNG_HEAD, Buffer.from('large picture')]);
  const small = Buffer.from('a 32 pixel bitmap');

  const modern = await exeIcon(write('Modern.exe', fakeExe([{ width: 32, bytes: small }, { width: 256, bytes: png }])));
  assert.deepEqual(modern, { bytes: png, extension: 'png', width: 256 });

  // Older programs hold bitmaps only: every size goes into one .ico.
  const bitmaps = [{ width: 16, bytes: Buffer.from('sixteen') }, { width: 48, bytes: Buffer.from('forty-eight!') }];
  const old = await exeIcon(write('Old.exe', fakeExe(bitmaps)));
  assert.equal(old.extension, 'ico');
  assert.equal(old.width, 48);
  const ico = old.bytes;
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 2]);
  const second = { width: ico[6 + 16], size: ico.readUInt32LE(6 + 16 + 8), offset: ico.readUInt32LE(6 + 16 + 12) };
  assert.equal(second.width, 48);
  assert.equal(String(ico.subarray(second.offset, second.offset + second.size)), 'forty-eight!');

  assert.equal(await exeIcon(write('NoIcon.exe', fakeExe([]))), null);
  assert.equal(await exeIcon(write('Text.exe', 'not a program')), null);
  await assert.rejects(exeIcon(write('Short.exe', 'MZ')));
});

test('the program of a game is found from OBS, launchers, and what Windows saw run', async (t) => {
  const { dir, write } = temp(t, 'programs');
  const at = (file) => path.join(dir, file);
  const riot = write('Riot Games/VALORANT/live/VALORANT.exe');
  write('Riot Games/VALORANT/live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe');
  const downloads = write('Downloads/Hollow Thing/HollowThing.exe');
  write('Downloads/HollowThing_setup.exe');
  write('Downloads/Install HollowThing.exe');
  const genshin = write('HoYoPlay/games/Genshin Impact game/GenshinImpact.exe');
  write('HoYoPlay/launcher.exe');
  const steam = write('steamapps/common/MECCHA CHAMELEON/PenguinHotel.exe');
  const java = write('ModrinthApp/meta/java_versions/zulu21/bin/javaw.exe');
  write('ModrinthApp/meta/java_versions/zulu21/bin/java.exe');
  write('Adoptium/jdk-21/bin/javaw.exe');
  const titled = write('Games/x/game_main.exe');

  let scans = 0;
  const programs = new Programs({
    remembered: async () => {
      scans += 1;
      return [
        { file: at('Riot Games/VALORANT/live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe'), name: 'VALORANT' },
        { file: riot, name: 'BootstrapPackagedGame' },
        { file: genshin, name: 'GenshinImpact.exe' },
        { file: at('HoYoPlay/launcher.exe'), name: 'HoYoPlay' },
        { file: at('Downloads/GenshinImpact_install_ua.exe'), name: 'HoYoPlay' },
        { file: at('Adoptium/jdk-21/bin/javaw.exe'), name: 'OpenJDK Platform binary' },
        { file: at('ModrinthApp/meta/java_versions/zulu21/bin/java.exe'), name: '' },
        { file: java, name: 'Minecraft NeoForge* 1.21.1' },
        { file: titled, name: 'Tiny Quest' }, // A running program, named by its window.
        { file: at('Gone/Elden Ring/eldenring.exe'), name: '' }, // Uninstalled since.
      ];
    },
    launchers: async () => [{ source: 'steam', name: 'MECCHA CHAMELEON', dir: path.dirname(steam) }],
    folders: async () => [at('Downloads')],
  });

  // OBS captured the real program, deep in Binaries: the one at the top of the game has its icon.
  assert.equal(await programs.find('valorant', ['VALORANT-Win64-Shipping.exe']), riot);
  assert.equal(await programs.find('genshinimpact'), genshin); // Seen by Windows, not by a launcher.
  assert.equal(await programs.find('hollowthing'), downloads); // Unpacked in Downloads, never an installer.
  assert.equal(await programs.find('mecchachameleon'), steam); // Its launcher knows its folder.
  assert.equal(await programs.find('minecraft'), java); // The Java of a Minecraft launcher.
  assert.equal(await programs.find('tinyquest'), titled);
  assert.equal(scans, 1);
  assert.equal(await programs.find('eldenring'), ''); // A program that is gone is not given.
  assert.equal(await programs.find(''), '');

  // A game not found is looked for again once the reading of the PC is old: it may have just started.
  programs.scannedAt = Date.now() - 10 * 60 * 1000;
  assert.equal(await programs.find('eldenring'), '');
  assert.equal(scans, 2);
});

test('a program found for a game is kept, and never replaces one picked by hand', () => {
  const games = new UserGames(store());
  games.add({ name: 'Indie', source: 'list' });
  games.add({ name: 'Picked', source: 'exe', program: 'D:\\Picked\\Picked.exe' });

  games.setFound('valorant', 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe');
  assert.deepEqual(games.programOf('valorant'), { file: 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe', picked: false });
  assert.equal(games.byProgram('VALORANT.exe'), ''); // Valorant was not added: its clips keep their names.

  games.setFound('indie', 'E:\\Games\\Indie\\IndieGame.exe');
  assert.deepEqual(games.programOf('indie'), { file: 'E:\\Games\\Indie\\IndieGame.exe', picked: false });
  assert.equal(games.byProgram('IndieGame.exe'), 'Indie'); // An added game is recognised by it in OBS logs.

  games.setFound('picked', 'D:\\Other\\Other.exe');
  assert.deepEqual(games.programOf('picked'), { file: 'D:\\Picked\\Picked.exe', picked: true });
});
