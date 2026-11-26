// The command palette (Ctrl+K): a few letters find a command, a clip, a game, a folder or a tag.
// Its items are built when it opens and nothing runs while it is closed.
import { h, icon, call } from './dom.js';
import { t, language } from './i18n.js';
import * as format from './format.js';
import { rankItems } from '/shared/palette.mjs';
import { LANGUAGES } from '/shared/i18n.mjs';
import { THEMES } from './themes.js';
import { openSettings } from './dialogs.js';
import { openStorage } from './storage.js';
import { openAddGame } from './addGame.js';
import { openDuplicates } from './duplicates.js';
import { openNews } from './news.js';

function itemsOf(app) {
  const { library, editor } = app;
  const { clips, categories = [], tags = [], games = [] } = app.state;
  // Lists and filters belong to the library: the editor closes first.
  const inLibrary = (run) => () => {
    if (editor.clip) app.closeClip();
    run();
  };
  const command = (symbol, label, run, hint = '') => ({ icon: symbol, label, run, hint, weight: 0 });
  const editing = editor.clip && [
    command('output', t('export.title'), () => editor.export(), 'Ctrl+E'),
    command('discord', t('discord.export'), () => editor.discord()),
    command('save', t('overwrite.go'), () => editor.overwrite(), 'Ctrl+S'),
    command('back', t('palette.backToClips'), () => app.closeClip(), t('key.escape')),
    command('cornersOut', t('palette.videoFull'), () => editor.setVideoOnly(true), 'F11'),
  ];
  const gameNames = [...new Map([...clips.map((clip) => clip.game), ...games.map((game) => game.name)]
    .filter(Boolean).map((name) => [name.toLowerCase(), name])).values()];
  const tagNames = [...new Set([...tags, ...clips.flatMap((clip) => clip.tags)])];
  return [
    ...(editing || []),
    command('grid', t('lib.allClips'), inLibrary(() => library.clearFilters())),
    command('heart', t('lib.favorites'), inLibrary(() => library.showView('favorites'))),
    command('list', t('lib.listView'), inLibrary(() => library.setLayout('list'))),
    command('grid', t('lib.gridView'), inLibrary(() => library.setLayout('grid'))),
    command('info', t('info.title'), inLibrary(() => library.toggleInfo()), 'Ctrl+I'),
    command('gear', t('settings.title'), () => openSettings(app)),
    command('drive', t('storage.title'), () => openStorage(app)),
    command('duplicate', t('dup.menu'), () => openDuplicates(app)),
    command('plus', t('games.add'), () => openAddGame(app)),
    command('keyboard', t('settings.showShortcuts'), () => call('showShortcuts')),
    command('history', t('news.open'), () => openNews(app.state.version, { afterUpdate: false })),
    command('refresh', t('lib.refresh'), () => call('rescan')),
    ...THEMES.map((theme) => ({ ...command('image', t('palette.theme', { name: theme.name }), () => call('setTheme', theme.id)), weight: 1 })),
    ...LANGUAGES.filter(({ id }) => id !== language)
      .map(({ id, name }) => ({ ...command('title', name, () => call('setLanguage', id)), detail: t('settings.language'), weight: 1 })),
    ...gameNames.map((name) => ({ icon: 'game', label: name, detail: t('palette.game'), weight: 1, run: inLibrary(() => library.chooseGame(name)) })),
    ...categories.map((name) => ({ icon: 'category', label: name, detail: t('palette.category'), weight: 1, run: inLibrary(() => library.openFolder(name)) })),
    ...tagNames.map((name) => ({ icon: 'tag', label: `#${name}`, detail: t('palette.tag'), weight: 1, run: inLibrary(() => library.chooseTag(name)) })),
    ...clips.filter((clip) => !clip.broken).map((clip) => ({
      icon: 'film',
      label: format.title(clip),
      detail: [clip.game, format.duration(clip.duration)].filter(Boolean).join(' · '),
      keywords: [clip.name, clip.game, clip.category, ...clip.tags.map((tag) => `#${tag}`)].join(' '),
      weight: 2,
      needsQuery: true,
      run: () => app.openClip(clip.id),
    })),
  ];
}

export function openPalette(app) {
  if (document.querySelector('dialog[open]')) return;
  const items = itemsOf(app);
  let shown = [];
  let active = 0;

  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const input = h('input', {
    class: 'field palette-input',
    placeholder: t('palette.placeholder'),
    'aria-label': t('palette.title'),
    spellcheck: 'false',
    onInput: () => {
      active = 0;
      render();
    },
    onKeydown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!shown.length) return;
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        paint();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        run(shown[active]);
      }
    },
  });
  const dialog = h('dialog', { class: 'palette' }, input, list,
    h('div', { class: 'palette-keys' }, t('palette.keys')));
  dialog.addEventListener('close', () => dialog.remove());
  // A click outside the box closes it, as in other apps.
  dialog.addEventListener('pointerdown', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  input.focus();

  function run(item) {
    if (!item) return;
    dialog.close();
    item.run();
  }

  function render() {
    shown = rankItems(items, input.value);
    list.replaceChildren(...(shown.length ? shown.map((item, i) => h('button', {
      class: 'palette-item',
      role: 'option',
      tabindex: -1,
      onPointermove: () => {
        if (active === i) return;
        active = i;
        paint();
      },
      onClick: () => run(item),
    }, icon(item.icon), h('span', { class: 'palette-label' }, item.label),
    item.detail && h('small', {}, item.detail),
    item.hint && h('kbd', {}, item.hint))) : [h('p', { class: 'palette-empty' }, t('palette.nothing'))]));
    paint();
  }

  function paint() {
    [...list.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  render();
}
