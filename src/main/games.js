// Turns the process captured by OBS into the name of a game.

const KNOWN = {
  'valorant-win64-shipping': 'Valorant',
  'cs2': 'Counter-Strike 2',
  'r5apex': 'Apex Legends',
  'r5apex_dx12': 'Apex Legends',
  'fortniteclient-win64-shipping': 'Fortnite',
  'league of legends': 'League of Legends',
  'rocketleague': 'Rocket League',
  'overwatch': 'Overwatch',
  'robloxplayerbeta': 'Roblox',
  'gta5': 'GTA V',
  'gta5_enhanced': 'GTA V',
  'marvel-win64-shipping': 'Marvel Rivals',
  'straftat': 'STRAFTAT',
  'minecraft.windows': 'Minecraft',
};

// "Capture any fullscreen application" also hooks programs that are not games.
const NOT_GAMES = new Set([
  'snippingtool', 'explorer', 'searchhost', 'applicationframehost', 'dwm', 'obs64', 'discord',
  'spotify', 'opera', 'chrome', 'msedge', 'firefox', 'brave', 'code', 'vlc', 'clipshelf', 'electron',
]);

/** `added` holds the games the user added: their programs name them first, even a browser. */
function gameFromProcess(executable, title = '', added = null) {
  const process = executable.trim().replace(/\.exe$/i, '');
  const id = process.toLowerCase();
  if (!id || id === 'unknown') return '';
  const mine = added?.byProgram(executable);
  if (mine) return mine;
  if (NOT_GAMES.has(id)) return '';
  if (Object.hasOwn(KNOWN, id)) return added ? added.spelling(KNOWN[id]) : KNOWN[id];
  const name = guessed(process, id, title);
  return added && name ? added.spelling(name) : name;
}

/** A name from the window title, or from the process when the title says nothing. */
function guessed(process, id, title) {
  const window = title.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  if (id === 'java' || id === 'javaw') {
    // Java games share their process name. Almost all are Minecraft, launchers and mods included.
    return !window || /minecraft/i.test(window) ? 'Minecraft' : window.slice(0, 40);
  }
  if (window && window.length <= 40) return window;
  return process.replace(/[-_](win64|win32|shipping|x64|dx1[12])/gi, '').replaceAll('_', ' ').trim();
}

module.exports = { gameFromProcess };
