// "Ajouter un jeu", from the + of the left column: a game installed with a launcher, a program picked
// by hand, or a name of the built-in list. An added game shows even before it has a clip.
import { h, icon, button, call, toast } from './dom.js';
import { openDialog, dialogHead, askText } from './dialogs.js';
import { GAMES, OTHER } from '/shared/gameList.mjs';
import { plain } from '/shared/search.mjs';
import { t } from './i18n.js';

const SOURCES = { steam: 'Steam', epic: 'Epic Games', riot: 'Riot Games', xbox: 'Xbox', list: t('games.sourceList') };
const LIST_SHOWN = 40;

// As plainName in the main process: "Baldur’s Gate 3" and "baldurs gate 3" are one game.
const slugOf = (name) => plain(String(name)).replace(/[^\p{L}\p{N}]/gu, '');

export function openAddGame(app) {
  let installed = null;
  const search = h('input', {
    class: 'field',
    type: 'search',
    placeholder: t('lib.findGame'),
    spellcheck: 'false',
    'aria-label': t('lib.findGame'),
    onInput: () => render(),
  });
  const list = h('div', { class: 'add-game-list' });

  const add = async (choice) => {
    const { ok, value } = await call('addGame', choice);
    if (!ok) return;
    toast(t('games.added', { name: value }));
    dialog.close();
  };

  const pick = async () => {
    const { ok, value } = await call('pickProgram');
    if (!ok || !value) return;
    const name = await askText({
      title: t('games.nameTitle'),
      symbol: 'game',
      text: t('games.nameText'),
      value: value.name,
      action: t('common.add'),
      maxLength: 60,
    });
    if (name?.trim()) add({ source: 'exe', name: name.trim(), program: value.program });
  };

  const row = (choice, added) => h('button', {
    type: 'button',
    class: 'add-game-row',
    disabled: added,
    'data-source': choice.source,
    'data-name': choice.name,
    title: added ? t('games.alreadyIn') : t('games.addOne', { name: choice.name }),
    onClick: () => add(choice),
  },
  h('span', { class: 'name' }, choice.name),
  h('span', { class: 'source' }, added ? t('games.alreadyAdded') : SOURCES[choice.source]));

  const hint = (text) => h('p', { class: 'hint' }, text);

  function render() {
    const mine = new Set((app.state.games || []).map((game) => slugOf(game.name)));
    const typed = search.value.trim();
    const wanted = slugOf(typed);
    const match = (name) => !wanted || slugOf(name).includes(wanted);
    const found = (installed || []).filter((game) => match(game.name));
    const taken = new Set(found.map((game) => slugOf(game.name)));
    const named = GAMES.filter((name) => name !== OTHER && match(name) && !taken.has(slugOf(name)));
    const exact = [...found.map((game) => game.name), ...GAMES].some((name) => slugOf(name) === wanted);

    list.replaceChildren(...[
      h('h3', {}, t('games.installed')),
      installed === null && hint(t('games.searching')),
      installed && !found.length && hint(wanted ? t('games.noMatch') : t('games.noneFound')),
      ...found.map((game) => row(game, mine.has(slugOf(game.name)))),
      h('h3', {}, t('games.others')),
      wanted && !exact && row({ source: 'list', name: typed.slice(0, 60) }, mine.has(wanted)),
      ...named.slice(0, LIST_SHOWN).map((name) => row({ source: 'list', name }, mine.has(slugOf(name)))),
      named.length > LIST_SHOWN && hint(t('games.more', { count: named.length - LIST_SHOWN })),
    ].filter(Boolean));
  }

  const dialog = openDialog(
    dialogHead({ title: t('games.add'), symbol: 'game' }),
    h('p', {}, t('games.intro')),
    h('div', { class: 'add-game-tools' },
      h('label', { class: 'add-game-search' }, icon('search'), search),
      button({ icon: 'folder', label: t('games.pickExe'), class: 'ghost', onClick: pick })),
    list,
    h('div', { class: 'dialog-actions' },
      button({ label: t('common.close'), onClick: () => dialog.close() })),
  );
  dialog.classList.add('add-game');
  render();
  search.focus();
  call('installedGames').then(({ ok, value }) => {
    installed = ok ? value : [];
    if (dialog.open) render();
  });
}
