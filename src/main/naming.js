// Guesses the game and the date of a clip from its path.
const path = require('node:path');

const GENERIC_FOLDERS = new Set([
  'desktop', 'bureau', 'searchhost', 'explorer', 'discord clips', 'videos', 'vidéos', 'clips',
  'replays', 'captures', 'recordings', 'screen recordings', 'nvidia', 'radeon relive', 'obs',
  'anydesk', 'steelseries moments', 'exported clips', 'shared clips', 'clipshelf', 'thumbs',
  'other', // Where ClipShelf puts the clips without a game.
]);

// "VALORANT_<uuid>"
const GAME_AND_UUID = /^(.+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /(20\d\d)[-_.](\d\d)[-_.](\d\d)[ _T-]+(\d\d)[-_.:h](\d\d)[-_.:m](\d\d)/;

function guessGame(file, root) {
  const named = path.parse(file).name.match(GAME_AND_UUID);
  if (named) return named[1].replaceAll('_', ' ');

  const parts = path.relative(root, path.dirname(file)).split(path.sep);
  const folder = parts.find((part) => part && !GENERIC_FOLDERS.has(part.toLowerCase()));
  // Some recorders name folders after the window class, e.g. "TankWindowClass_Overwatch".
  return folder ? folder.replace(/^.*WindowClass_/i, '').replaceAll('_', ' ').trim() : '';
}

function guessDate(file, fallback) {
  const match = path.basename(file).match(DATE);
  if (!match) return fallback;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function validName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length < 180
    && name === name.trim()
    && !/[<>:"/\\|?*\u0000-\u001f]/.test(name)
    && !name.endsWith('.')
    && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);
}

module.exports = { guessGame, guessDate, validName };
