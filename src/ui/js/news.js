// "What's new", once after an update, and from the palette at any time. Each version lists its news
// here, newest first; the arrows of the dialog go through older versions. A version may open with an
// illustration (`hero`), drawn in HTML and CSS, so nothing has to be downloaded or packed as a picture.
// A version without news shows nothing after an update, and is marked as seen.
import { h, icon, button, call } from './dom.js';
import { t } from './i18n.js';
import { openDialog, dialogHead } from './dialogs.js';

const NEWS = {
  '1.13.6': [{ key: 'news.updateReopen', symbol: 'refresh' }],
  '1.13.5': [{ key: 'news.updateProgress', symbol: 'refresh' }],
  '1.13.4': [{ key: 'news.updateQuiet', symbol: 'refresh' }],
  '1.13.3': [
    { key: 'news.videoControls', symbol: 'cornersOut' },
    { key: 'news.videoDrawers', symbol: 'crosshair' },
    { key: 'news.infoTab', symbol: 'info' },
    { key: 'news.updateWindow', symbol: 'refresh' },
  ],
  '1.13.2': [
    { key: 'news.videoFull', symbol: 'film' },
    { key: 'news.videoSize', symbol: 'size' },
  ],
  '1.13.1': {
    hero: 'transitions',
    items: [
      { key: 'news.transitions', symbol: 'transition' },
      { key: 'news.transitionsSound', symbol: 'wave' },
      { key: 'news.transitionsEdit', symbol: 'cursor' },
      { key: 'news.history', symbol: 'history' },
    ],
  },
  '1.13.0': [
    { key: 'news.pieceVolume', symbol: 'volume' },
    { key: 'news.rangeVolume', symbol: 'range' },
    { key: 'news.editorFixes', symbol: 'check' },
    { key: 'news.updates', symbol: 'refresh' },
  ],
  '1.12.0': [
    { key: 'news.palette', symbol: 'search' },
    { key: 'news.list', symbol: 'list' },
    { key: 'news.info', symbol: 'info' },
    { key: 'news.status', symbol: 'gauge' },
    { key: 'news.tips', symbol: 'keyboard' },
    { key: 'news.window', symbol: 'fit' },
  ],
  '1.11.0': [
    { key: 'news.welcome', symbol: 'tick' },
  ],
  '1.10.0': [
    { key: 'news.thumbnail', symbol: 'image' },
    { key: 'news.backups', symbol: 'history' },
  ],
  '1.9.0': [
    { key: 'news.duplicates', symbol: 'duplicate' },
  ],
  '1.8.1': [
    { key: 'news.log', symbol: 'info' },
  ],
  '1.8.0': [
    { key: 'news.languages', symbol: 'title' },
    { key: 'news.faster', symbol: 'gauge' },
  ],
  '1.7.4': [
    { key: 'news.exportLog', symbol: 'list' },
  ],
  '1.7.3': [
    { key: 'news.discordIntact', symbol: 'discord' },
  ],
  '1.7.0': [
    { key: 'news.exeLogos', symbol: 'game' },
  ],
  '1.6.0': [
    { key: 'news.games', symbol: 'game' },
  ],
  '1.5.0': [
    { key: 'news.discord', symbol: 'discord' },
    { key: 'news.checked', symbol: 'check' },
    { key: 'news.openPlays', symbol: 'play' },
  ],
};

const versionParts = (version) => version.split('.').map(Number);
const newestFirst = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};
const VERSIONS = Object.keys(NEWS).sort(newestFirst);
const itemsOf = (version) => (Array.isArray(NEWS[version]) ? NEWS[version] : NEWS[version].items);

/** Pictures of the transitions, played in a loop: a wipe, a dissolve, an iris, over a small timeline. */
function transitionsHero() {
  const names = ['wipe', 'dissolve', 'iris'];
  return h('div', { class: 'news-hero hero-transitions', 'aria-hidden': 'true' },
    h('div', { class: 'hero-screen' },
      h('div', { class: 'hero-shot shot-a' }, h('i'), h('i')),
      h('div', { class: 'hero-shot shot-b' }, h('i'), h('i')),
      h('div', { class: 'hero-shot shot-c' }, h('i'), h('i')),
      h('div', { class: 'hero-names' }, ...names.map((kind) => h('span', { class: `name-${kind}` }, icon('transition'), t(`transition.${kind}`))))),
    h('div', { class: 'hero-timeline' },
      h('div', { class: 'hero-lane' }, h('b', { class: 'piece-a' }), h('b', { class: 'piece-b' }), h('b', { class: 'piece-a2' }), h('b', { class: 'piece-c' }),
        ...[1, 2, 3].map((n) => h('em', { class: `band band-${n}` }))),
      h('div', { class: 'hero-lane sound' }, h('b', { class: 'piece-a' }), h('b', { class: 'piece-b' }), h('b', { class: 'piece-a2' }), h('b', { class: 'piece-c' }),
        ...[1, 2, 3].map((n) => h('em', { class: `band band-${n}` }))),
      h('i', { class: 'hero-playhead' })));
}

const HEROES = { transitions: transitionsHero };

/**
 * Opens the news of `version`. After an update (`afterUpdate`), a version without news is only
 * marked as seen; from the palette, the newest news shows instead.
 */
export function openNews(version, { afterUpdate = true } = {}) {
  let index = VERSIONS.indexOf(version);
  if (index < 0) {
    if (afterUpdate) {
      call('newsSeen');
      return;
    }
    index = 0;
  }
  const title = h('h2');
  const page = h('div', { class: 'news-page' });
  const older = button({ icon: 'back', title: t('news.older'), class: 'ghost', onClick: () => show(index + 1) });
  const newer = button({ icon: 'next', title: t('news.newer'), class: 'ghost', onClick: () => show(index - 1) });
  const where = h('span', { class: 'news-where' });
  const head = dialogHead({ title: '', symbol: 'tick' });
  head.querySelector('h2').replaceWith(title);
  head.append(h('div', { class: 'news-nav' }, older, where, newer));

  function show(next) {
    if (next < 0 || next >= VERSIONS.length) return;
    index = next;
    const shown = VERSIONS[index];
    title.textContent = t('news.title', { version: shown });
    const hero = !Array.isArray(NEWS[shown]) && HEROES[NEWS[shown].hero];
    page.replaceChildren(...[
      hero && hero(),
      h('ul', { class: 'news' }, ...itemsOf(shown).map(({ key, symbol }) => h('li', {}, icon(symbol), h('span', {}, t(key))))),
    ].filter(Boolean));
    older.disabled = index >= VERSIONS.length - 1;
    newer.disabled = index <= 0;
    where.textContent = t('news.page', { n: VERSIONS.length - index, total: VERSIONS.length });
  }

  const dialog = openDialog(
    head,
    page,
    h('div', { class: 'dialog-actions' },
      button({ label: t('news.ok'), class: 'primary', autofocus: true, onClick: () => dialog.close() })),
  );
  dialog.classList.add('news-dialog');
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(index + 1);
    else if (event.key === 'ArrowRight') show(index - 1);
    else return;
    event.preventDefault();
  });
  if (afterUpdate) dialog.addEventListener('close', () => call('newsSeen'));
  show(index);
}
