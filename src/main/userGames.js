// Games the user added with the + of the left column. Each one shows even without a clip, and the
// programs it lists name it when the OBS logs say which process was captured.
const path = require('node:path');
const { plainName } = require('./launchers');
const { t } = require('./i18n');

const NAME_LENGTH = 60;
const MAX_GAMES = 300;
const MAX_PROGRAMS = 64;
const SOURCES = new Set(['steam', 'epic', 'riot', 'xbox', 'exe', 'list']);
// Names that many games give their programs: found in a folder, they would name the wrong game.
const GENERIC = new Set(['game', 'launcher', 'start', 'play', 'client', 'main', 'app', 'bin', 'run']);

/** "VALORANT.exe" and "VALORANT-Win64-Shipping.exe" are the same game for the OBS logs. */
function programKey(file) {
  return path.win32.basename(String(file || '')).toLowerCase().replace(/\.exe$/, '')
    .replace(/[-_](win64|win32|shipping|x64|dx1[12])/g, '').trim();
}

const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH);

class UserGames {
  constructor(settings) {
    this.settings = settings;
    if (!Array.isArray(settings.data.games)) settings.data.games = [];
    // Programs ClipShelf found for games that are not added: plain name -> file.
    if (!settings.data.programs || typeof settings.data.programs !== 'object') settings.data.programs = {};
  }

  list() {
    return this.settings.data.games;
  }

  find(name) {
    const slug = plainName(name);
    return slug ? this.list().find((game) => plainName(game.name) === slug) : undefined;
  }

  /**
   * `programs` are the files found in the folder of the game, `program` the one whose icon stands
   * for it. Adding a game that is already there keeps its name and adds the programs.
   */
  add({ name, source, programs = [], program = '' }) {
    const typed = cleanName(name);
    if (!plainName(typed)) throw new Error(t('games.needName'));
    if (!SOURCES.has(source)) throw new Error(t('games.unknownSource'));
    const picked = source === 'exe';
    const keys = [program, ...programs]
      .map((file) => ({ key: programKey(file), mine: file === program }))
      .filter(({ key, mine }) => key && (picked && mine ? true : !GENERIC.has(key)))
      .map(({ key }) => key);

    const known = this.find(typed);
    if (!known && this.list().length >= MAX_GAMES) throw new Error(t('games.tooMany'));
    const game = known || { name: typed, source, programs: [], program: '', added: Date.now() };
    game.programs = [...new Set([...game.programs, ...keys])].slice(0, MAX_PROGRAMS);
    // A program picked by hand wins: the user chose its icon.
    if (program && (picked || !game.program)) {
      game.program = program;
      game.source = source;
    }
    if (!known) this.list().push(game);
    this.settings.save();
    return game.name;
  }

  remove(name) {
    const slug = plainName(name);
    this.settings.data.games = this.list().filter((game) => plainName(game.name) !== slug);
    this.settings.save();
  }

  /** The added game that this process belongs to, or ''. */
  byProgram(executable) {
    const key = programKey(executable);
    return (key && this.list().find((game) => game.programs.includes(key))?.name) || '';
  }

  /** The spelling the user gave to a game, so that "VALORANT" from a window title becomes their "Valorant". */
  spelling(name) {
    return this.find(name)?.name || name;
  }

  /** For the logos: the program of a game, and whether the user picked it by hand. */
  programOf(slug) {
    const game = this.list().find((candidate) => plainName(candidate.name) === slug);
    if (game?.program) return { file: game.program, picked: game.source === 'exe' };
    const found = this.settings.data.programs[slug];
    return typeof found === 'string' && found ? { file: found, picked: false } : null;
  }

  /**
   * Keeps the program ClipShelf found for a game. An added game without one takes it, and with it
   * the clips where OBS captured that program. A program picked by hand is never replaced.
   */
  setFound(slug, file) {
    const game = this.list().find((candidate) => plainName(candidate.name) === slug);
    if (game && game.source === 'exe') return;
    if (game) {
      game.program = file;
      const key = programKey(file);
      if (key && !GENERIC.has(key) && !game.programs.includes(key) && game.programs.length < MAX_PROGRAMS) game.programs.push(key);
    } else {
      this.settings.data.programs[slug] = file;
    }
    this.settings.save();
  }
}

module.exports = { UserGames, programKey };
