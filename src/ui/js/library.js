import { h, icon, button, slider, call, remember, store } from './dom.js';
import { openSettings } from './dialogs.js';
import { dropdown, showMenu } from './menu.js';
import * as format from './format.js';
import { searcher, plain } from '/shared/search.mjs';
import { KINDS, countMoments, multiKill } from '/shared/moments.mjs';
import { OTHER } from '/shared/gameList.mjs';
import { gameBadge } from './gameBadge.js';
import { openStorage } from './storage.js';
import { openDuplicates } from './duplicates.js';
import { compressible } from '/shared/storage.mjs';
import { categoryColor, pickCategory } from './categories.js';
import { startDrag } from './dragDrop.js';
import { toast } from './dom.js';
import { t, language } from './i18n.js';
import { Preview } from './preview.js';
import { openDiscord } from './export.js';
import { openAddGame } from './addGame.js';
import { listHead, listRow, infoPanel } from './clipViews.js';
import { openPalette } from './palette.js';

/** What a dragged clip can be dropped on. */
const CLIP_TARGETS = '.rail .game.category, .rail .tags .tag, .rail-body .game[data-game], .rail .game.favorites';

const VIEWS = [
  { id: 'all', label: t('lib.all'), title: t('lib.allClips'), icon: 'grid', color: 'gpu', match: () => true },
  { id: 'favorites', label: t('lib.favorites'), icon: 'heart', color: 'liked', match: (clip) => clip.favorite },
];

const GAME_COLORS = ['cpu', 'disk', 'ram', 'net', 'ok', 'charge', 'warn', 'gpu'];

const SORTS = {
  newest: [t('sort.newest'), (a, b) => b.date - a.date],
  oldest: [t('sort.oldest'), (a, b) => a.date - b.date],
  favorites: [t('sort.favorites'), (a, b) => b.favorite - a.favorite || b.date - a.date],
  longest: [t('sort.longest'), (a, b) => b.duration - a.duration],
  shortest: [t('sort.shortest'), (a, b) => a.duration - b.duration],
  largest: [t('sort.largest'), (a, b) => b.size - a.size],
  kills: [t('sort.kills'), (a, b) => counted(b).best - counted(a).best || counted(b).kill - counted(a).kill || b.date - a.date],
  name: [t('sort.name'), (a, b) => format.title(a).localeCompare(format.title(b), language, { numeric: true })],
};

const MOMENT_FILTERS = {
  any: [t('moments.any'), null, () => true],
  kills: [t('moments.kills'), 'crosshair', ({ kill }) => kill >= 1],
  multi: [t('moments.multi'), 'crosshair', ({ best }) => best >= 3],
  five: [t('moments.five'), 'crosshair', ({ best }) => best >= 5],
  deaths: [t('moments.deaths'), 'skull', ({ death }) => death >= 1],
  alive: [t('moments.alive'), 'check', ({ kill, death }) => kill >= 1 && !death],
  marks: [t('moments.marks'), 'flag', ({ mark }) => mark >= 1],
};
/** Clips whose game is not known are shown under "Other". */
const gameOf = (clip) => clip.game || OTHER;
const counted = (clip) => countMoments(clip.moments, clip.rounds);

const NO_FILTER = { view: 'all', scope: 'all', games: [], categories: [], tags: [], moment: 'any', query: '' };
/** A clip put in a category is in that folder, no longer with the clips of its game. */
const loose = (clip) => !clip.category;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
/** Adds a value that is not there, removes one that is. */
const toggle = (list, value) => (list.some((item) => sameName(item, value))
  ? list.filter((item) => !sameName(item, value))
  : [...list, value]);
/** Ctrl, or Cmd, adds to what is selected instead of replacing it. */
const adds = (event) => event.ctrlKey || event.metaKey;

const PREVIEW_DELAY = 350;
const CARD_TAGS = 3;

export class Library {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.filter = { ...NO_FILTER };
    this.sort = remember('sort', 'newest');
    if (!SORTS[this.sort]) this.sort = 'newest';
    this.selected = new Set();
    this.cards = new Map();
    this.built = new Map();
    this.shown = null;
    this.visible = [];
    // Grid of cards or list of rows, and the info panel on the right: kept for the next start.
    this.layout = remember('layout', 'grid') === 'list' ? 'list' : 'grid';
    this.infoOpen = Boolean(remember('infoOpen', false));
    this.anchor = null;
    // Where the pointer is, so that a menu opened from the keyboard appears there.
    this.pointer = null;
    addEventListener('pointermove', (event) => { this.pointer = { x: event.clientX, y: event.clientY }; });
    document.documentElement.addEventListener('pointerleave', () => { this.pointer = null; });
    this.build();
    app.subscribe(() => this.render());
  }

  build() {
    this.search = h('input', {
      class: 'field',
      type: 'search',
      placeholder: t('lib.searchHint'),
      title: t('lib.searchTitle'),
      spellcheck: 'false',
      onInput: () => {
        this.filter.query = this.search.value;
        this.render();
        this.content.scrollTop = 0;
        this.suggestTags();
      },
      onKeydown: (event) => this.suggestKey(event),
      onBlur: () => this.hideSuggestions(),
      onClick: () => this.suggestTags(),
    });
    this.suggestions = h('div', { class: 'suggest', role: 'listbox', hidden: true });
    this.suggestion = null;
    this.clearSearch = button({
      icon: 'close',
      title: t('lib.clearSearch'),
      class: 'ghost clear',
      hidden: true,
      onClick: () => this.setQuery(''),
    });
    this.momentFilter = dropdown({
      class: 'moment-filter',
      title: t('lib.momentFilter'),
      value: 'any',
      options: Object.entries(MOMENT_FILTERS).map(([value, [label, symbol]]) => ({ value, label, icon: symbol })),
      onChange: (moment) => this.setFilter({ moment }),
    });

    const sort = this.sortPicker = dropdown({
      class: 'sort',
      title: t('lib.sort'),
      value: this.sort,
      options: Object.entries(SORTS).map(([value, [label]]) => ({ value, label })),
      onChange: (value) => {
        this.sort = value;
        store('sort', value);
        this.render();
      },
    });

    const cardSize = remember('cardSize', 250);
    const size = slider({
      class: 'size',
      min: 180, max: 440, step: 10,
      title: t('lib.cardSize'),
      value: cardSize,
      onInput: (value) => {
        this.content.style.setProperty('--card', `${value}px`);
        store('cardSize', value);
      },
    });

    this.gameSearch = h('input', {
      class: 'rail-search',
      type: 'search',
      placeholder: t('lib.find'),
      spellcheck: 'false',
      'aria-label': t('lib.findGame'),
      onInput: () => {
        this.railShown = null;
        this.renderRail(this.app.state.clips);
      },
      onKeydown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          this.gameSearch.value = '';
          this.railShown = null;
          this.renderRail(this.app.state.clips);
        }
      },
    });
    // Built once, so that typing in it never loses the focus.
    this.railHead = h('div', { class: 'caption with-action games-head' }, h('span', {}, t('lib.games')),
      h('label', { class: 'rail-find' }, icon('search'), this.gameSearch),
      button({
        icon: 'plus',
        title: t('games.add'),
        class: 'ghost rail-add add-game',
        onClick: () => openAddGame(this.app),
      }));
    this.railBody = h('div', { class: 'rail-body' });
    this.railTop = h('div', { class: 'rail-top' });
    this.rail = h('aside', { class: 'rail' }, this.railTop, this.railHead, this.railBody);
    this.heading = h('h1');
    this.summary = h('span');
    this.content = h('div', {
      class: 'content',
      style: { '--card': `${cardSize}px` },
      onClick: (event) => {
        if (!event.target.closest('.card, .list-row')) this.select([]);
      },
    });
    this.info = h('aside', { class: 'info-panel', hidden: !this.infoOpen, 'aria-label': t('info.title') });
    this.sizeSlider = size;
    this.layoutButtons = {
      grid: button({ icon: 'grid', title: t('lib.gridView'), class: 'ghost', onClick: () => this.setLayout('grid') }),
      list: button({ icon: 'list', title: t('lib.listView'), class: 'ghost', onClick: () => this.setLayout('list') }),
    };
    this.infoButton = button({ icon: 'info', title: t('info.toggleKey'), class: 'ghost', onClick: () => this.toggleInfo() });
    this.bar = h('div', { class: 'selection', hidden: true });
    const version = h('small', { class: 'version' });
    this.app.subscribe(() => {
      version.textContent = this.app.state.version ? `v${this.app.state.version}` : '';
    });

    this.root.replaceChildren(
      h('header', { class: 'topbar drag-region' },
        h('div', { class: 'brand' }, h('img', { src: 'icon.png', alt: '' }), 'ClipShelf', version),
        h('div', { class: 'spacer' }),
        button({ icon: 'search', title: t('palette.button'), class: 'ghost palette-open', onClick: () => openPalette(this.app) }),
        button({ icon: 'drive', title: t('storage.title'), class: 'ghost', onClick: () => openStorage(this.app) }),
        button({ icon: 'refresh', title: t('lib.refresh'), class: 'ghost', onClick: () => call('rescan') }),
        button({ icon: 'gear', title: t('settings.title'), class: 'ghost', onClick: () => openSettings(this.app) })),
      this.rail,
      h('main', { class: 'main' },
        h('div', { class: 'view-head' },
          h('div', { class: 'view-title' }, this.heading, this.summary),
          h('div', { class: 'search' }, icon('search'), this.search, this.clearSearch, this.suggestions),
          this.momentFilter,
          sort,
          size,
          h('div', { class: 'segmented' }, this.layoutButtons.grid, this.layoutButtons.list),
          this.infoButton),
        h('div', { class: 'main-body' }, this.content, this.info)),
      this.bar,
    );
    this.paintLayout();
  }

  /** "favorites" or "all", alone. */
  showView(id) {
    this.clearInputs();
    this.setFilter({ ...NO_FILTER, view: id });
  }

  setSort(value) {
    if (!SORTS[value] || value === this.sort) return;
    this.sort = value;
    store('sort', value);
    this.sortPicker.value = value;
    this.render();
  }

  setLayout(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    store('layout', layout);
    this.shown = null;
    this.paintLayout();
    this.render();
  }

  toggleInfo() {
    this.infoOpen = !this.infoOpen;
    store('infoOpen', this.infoOpen);
    this.info.hidden = !this.infoOpen;
    this.paintLayout();
    this.renderInfo();
  }

  paintLayout() {
    this.content.classList.toggle('as-list', this.layout === 'list');
    this.sizeSlider.hidden = this.layout === 'list';
    for (const [id, el] of Object.entries(this.layoutButtons)) el.classList.toggle('active', id === this.layout);
    this.infoButton.classList.toggle('active', this.infoOpen);
  }

  /** Read only while the panel is open: closed, it costs nothing. */
  renderInfo() {
    if (!this.infoOpen) return;
    const clips = this.selection();
    const key = JSON.stringify([clips, this.app.state.logos]);
    if (key === this.infoShown) return;
    this.infoShown = key;
    this.info.replaceChildren(...infoPanel(this.app, clips).filter(Boolean));
  }

  matching() {
    const { view, scope, games, categories, tags, moment, query } = this.filter;
    const inView = VIEWS.find((v) => v.id === view).match;
    const found = searcher(query, format.title);
    const [, , wanted] = MOMENT_FILTERS[moment];
    return this.app.state.clips.filter((clip) => {
      if (!inView(clip)) return false;
      if (scope === 'games' && !loose(clip)) return false;
      if (games.length && !games.some((game) => sameName(game, gameOf(clip)))) return false;
      if (categories.length && !categories.includes(clip.category)) return false;
      if (tags.length && !tags.some((tag) => clip.tags.includes(tag))) return false;
      return wanted(counted(clip)) && found(clip);
    }).sort(SORTS[this.sort][1]);
  }

  /** A category is a folder: opening it shows all its clips, whatever game was chosen. */
  openFolder(name, event = {}) {
    const { categories } = this.filter;
    if (adds(event)) {
      this.setFilter({ view: 'all', categories: toggle(categories, name), games: [], scope: 'all' });
      return;
    }
    const only = categories.length === 1 && categories[0] === name;
    this.clearInputs();
    this.setFilter({ ...NO_FILTER, categories: only ? [] : [name] });
  }

  chooseGame(name, event = {}) {
    const { games } = this.filter;
    if (adds(event)) {
      this.setFilter({ view: 'all', scope: 'games', games: toggle(games, name), categories: [] });
      return;
    }
    const only = games.length === 1 && sameName(games[0], name);
    this.clearInputs();
    this.setFilter({ ...NO_FILTER, scope: 'games', games: only ? [] : [name] });
  }

  /** A tag is a quick search: all its clips, wherever they are. With Ctrl, tags add up. */
  chooseTag(name, event = {}) {
    const { tags } = this.filter;
    if (adds(event)) {
      this.setFilter({ tags: toggle(tags, name) });
      return;
    }
    const only = tags.length === 1 && tags[0] === name;
    this.clearInputs();
    this.setFilter({ ...NO_FILTER, tags: only ? [] : [name] });
  }

  clearInputs() {
    this.search.value = '';
    this.momentFilter.value = 'any';
  }

  /** After a "#", the tags that start with or contain what follows it. */
  suggestTags() {
    const { value } = this.search;
    const caret = this.search.selectionStart ?? value.length;
    const word = /(^|\s)#([^\s#]*)$/.exec(value.slice(0, caret));
    if (!word) {
      this.hideSuggestions();
      return;
    }
    const typed = plain(word[2]);
    const counts = new Map();
    for (const clip of this.app.state.clips) for (const tag of clip.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    const items = [...counts]
      .filter(([tag]) => plain(tag).includes(typed))
      .sort(([a, x], [b, y]) => plain(b).startsWith(typed) - plain(a).startsWith(typed) || y - x || a.localeCompare(b, language))
      .slice(0, 8);
    if (!items.length) {
      this.hideSuggestions();
      return;
    }
    const index = Math.min(this.suggestion?.index ?? 0, items.length - 1);
    this.suggestion = { start: caret - word[2].length - 1, end: caret, items, index };
    this.suggestions.replaceChildren(...items.map(([tag, count], i) => h('button', {
      type: 'button',
      class: `suggest-item ${i === index ? 'active' : ''}`,
      role: 'option',
      'aria-selected': String(i === index),
      tabindex: -1,
      // Picked on press: a click would first take the focus from the field.
      onMousedown: (event) => {
        event.preventDefault();
        this.pickTag(tag);
      },
    }, h('span', {}, `#${tag}`), h('small', {}, String(count)))));
    this.suggestions.hidden = false;
  }

  hideSuggestions() {
    this.suggestion = null;
    this.suggestions.hidden = true;
  }

  pickTag(tag) {
    const { start, end } = this.suggestion;
    const { value } = this.search;
    const inserted = `#${tag} `;
    this.search.value = value.slice(0, start) + inserted + value.slice(end).replace(/^\s+/, '');
    const caret = start + inserted.length;
    this.search.setSelectionRange(caret, caret);
    this.hideSuggestions();
    this.setFilter({ query: this.search.value });
  }

  suggestKey(event) {
    const { suggestion } = this;
    if (!suggestion) return;
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (Object.hasOwn(moves, event.key)) {
      suggestion.index = (suggestion.index + moves[event.key] + suggestion.items.length) % suggestion.items.length;
      this.suggestTags();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      this.pickTag(suggestion.items[suggestion.index][0]);
    } else if (event.key === 'Escape') {
      this.hideSuggestions();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  setQuery(query) {
    this.search.value = query;
    this.setFilter({ query });
    this.search.focus();
  }

  clearFilters() {
    this.clearInputs();
    this.setFilter({ ...NO_FILTER });
  }

  get filtered() {
    const { view, scope, games, categories, tags, moment, query } = this.filter;
    return view !== 'all' || scope !== 'all' || games.length || categories.length || tags.length || moment !== 'any' || query.trim();
  }

  render() {
    if (this.root.hidden) return; // Rendered again when shown.
    const { clips, categories = [] } = this.app.state;
    this.clearSearch.hidden = !this.filter.query;
    this.filter.categories = this.filter.categories.filter((name) => categories.includes(name));
    const known = new Set([...clips.flatMap((clip) => clip.tags), ...(this.app.state.tags || [])]);
    this.filter.tags = this.filter.tags.filter((tag) => known.has(tag));
    const ids = new Set(clips.map((clip) => clip.id));
    for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);

    this.renderRail(clips);
    this.visible = this.matching();
    this.renderContent();
    this.paintSelection();
  }

  setFilter(change) {
    Object.assign(this.filter, change);
    this.selected.clear();
    this.render();
    this.content.scrollTop = 0;
  }

  renderRail(clips) {
    const games = new Map();
    const tags = new Map();
    for (const clip of clips) {
      if (loose(clip)) games.set(gameOf(clip), (games.get(gameOf(clip)) || 0) + 1);
      for (const tag of clip.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    for (const tag of this.app.state.tags || []) if (!tags.has(tag)) tags.set(tag, 0);
    // Games added with + show before they have a clip.
    for (const { name } of this.app.state.games || []) {
      if (![...games.keys()].some((game) => sameName(game, name))) games.set(name, 0);
    }
    const { filter } = this;
    const inGames = filter.scope === 'games';
    const { categories = [], logos = {}, detection } = this.app.state;
    const alphabetical = [...games.keys()].sort();
    const wanted = plain(this.gameSearch.value.trim());
    // "Other" goes last, whatever its count.
    const order = ([a, countA], [b, countB]) => (a === OTHER) - (b === OTHER) || countB - countA;
    // Rebuilding would make the logos blink on each scan.
    const state = JSON.stringify([[...games], [...tags], filter, categories, logos, detection?.left, wanted,
      clips.length, categories.map((name) => clips.filter((clip) => clip.category === name).length)]);
    if (state === this.railShown) return;
    this.railShown = state;

    const ctrl = t('lib.ctrlClick');
    const shownGames = [...games].sort(order).filter(([name]) => !wanted || plain(name).includes(wanted));
    this.railTop.replaceChildren(
      h('button', {
        class: `game everything ${this.filtered ? '' : 'active'}`,
        style: { '--tint': 'var(--accent)' },
        title: t('lib.allTitle'),
        'aria-pressed': String(!this.filtered),
        onClick: () => this.clearFilters(),
      },
      h('span', { class: 'badge-icon' }, icon('grid')),
      h('span', { class: 'name' }, t('lib.allClips')),
      h('span', { class: 'count' }, String(clips.length))),
      h('button', {
        class: `game favorites ${filter.view === 'favorites' ? 'active' : ''}`,
        style: { '--tint': 'var(--liked)' },
        title: t('lib.favoritesTitle'),
        'aria-pressed': String(filter.view === 'favorites'),
        onClick: () => {
          this.clearInputs();
          this.setFilter({ ...NO_FILTER, view: filter.view === 'favorites' ? 'all' : 'favorites' });
        },
      },
      h('span', { class: 'badge-icon' }, icon('heart')),
      h('span', { class: 'name' }, t('lib.favorites')),
      h('span', { class: 'count' }, String(clips.filter((clip) => clip.favorite).length))),
    );
    this.railBody.replaceChildren(...[
      ...shownGames.map(([name, count]) => {
        const active = filter.games.some((game) => sameName(game, name));
        const color = GAME_COLORS[alphabetical.indexOf(name) % GAME_COLORS.length];
        const el = h('button', {
          class: `game ${active ? 'active' : ''}`,
          style: { '--tint': `var(--${color})` },
          'data-game': name,
          title: `${name}\n${ctrl}\n${t('lib.dropOnGame')}`,
          'aria-pressed': String(active),
          onClick: (event) => this.chooseGame(name, event),
          onContextmenu: (event) => this.gameMenu(name, event),
        },
        // The button takes the colour of the logo.
        gameBadge(name, logos, (tint) => el.style.setProperty('--tint', tint)),
        h('span', { class: 'name' }, name),
        h('span', { class: 'count' }, String(count)));
        return el;
      }),
      wanted && !shownGames.length && h('p', { class: 'hint' }, t('lib.noGame')),
      games.size === 1 && games.has(OTHER) && h('p', { class: 'hint' }, t('lib.giveGame')),
      !games.size && clips.length > 0 && h('p', { class: 'hint' }, t('lib.allFiled')),
      h('div', { class: 'caption with-action' }, t('lib.categories'),
        button({
          icon: 'plus',
          title: t('lib.newCategory'),
          class: 'ghost rail-add add-category',
          onClick: () => this.app.actions.newCategory(),
        })),
      ...categories.map((name) => {
        const active = filter.categories.includes(name);
        return h('button', {
          class: `game category ${active ? 'active' : ''}`,
          style: { '--tint': `var(--${categoryColor(categories, name)})` },
          'data-category': name,
          title: `${name}\n${ctrl}\n${t('lib.dropOnCategory')}`,
          'aria-pressed': String(active),
          onClick: (event) => this.openFolder(name, event),
          onContextmenu: (event) => this.categoryMenu(name, event),
        },
        h('span', { class: 'badge-icon' }, icon('category')),
        h('span', { class: 'name' }, name),
        h('span', { class: 'count' }, String(clips.filter((clip) => clip.category === name).length)));
      }),
      !categories.length && h('p', { class: 'hint' }, t('lib.makeCategory')),
      h('div', { class: 'caption with-action' }, t('lib.tags'),
        button({
          icon: 'plus',
          title: t('lib.newTag'),
          class: 'ghost rail-add add-tag',
          onClick: () => this.app.actions.newTag(this.selection()),
        })),
      !tags.size && h('p', { class: 'hint' }, t('lib.makeTag')),
      tags.size > 0 && h('div', { class: 'tags' }, [...tags].sort().map(([name, count]) => h('button', {
        class: `tag ${filter.tags.includes(name) ? 'active' : ''}`,
        'data-tag': name,
        title: `${t('lib.tagClips', { tag: name })}\n${ctrl}\n${t('lib.dragTag')}`,
        onClick: (event) => this.chooseTag(name, event),
        onPointerdown: (event) => startDrag(event, {
          payload: name,
          label: `#${name}`,
          symbol: 'tag',
          accepts: '.card[data-id], .list-row[data-id]',
          onDrop: (tag, card) => this.dropTag(tag, card),
        }),
        onContextmenu: (event) => this.tagMenu(name, event),
      }, `#${name}`, h('span', { class: 'tag-count' }, `(${count})`)))),
    ].filter(Boolean));
  }

  gameMenu(name, event) {
    event.preventDefault();
    const added = (this.app.state.games || []).some((game) => sameName(game.name, name));
    showMenu({
      x: event.clientX,
      y: event.clientY,
      title: name,
      items: [
        { icon: 'image', label: t('games.chooseLogo'), run: () => call('chooseLogo', name) },
        { icon: 'refresh', label: t('games.autoLogo'), run: () => call('automaticLogo', name) },
        // Its clips keep their game: only the entry of the column goes.
        ...(added ? ['-', { icon: 'close', label: t('games.remove'), run: () => call('removeGame', name) }] : []),
      ],
    });
  }

  categoryMenu(name, event) {
    event.preventDefault();
    const { actions } = this.app;
    showMenu({
      x: event.clientX,
      y: event.clientY,
      title: name,
      items: [
        {
          icon: 'pencil',
          label: t('common.rename'),
          run: async () => {
            const renamed = await actions.renameCategory(name);
            if (renamed) this.setFilter({ categories: [renamed] });
          },
        },
        '-',
        { icon: 'trash', label: t('lib.deleteCategory'), danger: true, run: () => actions.removeCategory(name) },
      ],
    });
  }

  tagMenu(name, event) {
    event.preventDefault();
    const { actions } = this.app;
    showMenu({
      x: event.clientX,
      y: event.clientY,
      title: `#${name}`,
      items: [
        {
          icon: 'pencil',
          label: t('common.rename'),
          run: async () => {
            const renamed = await actions.renameTag(name);
            if (renamed) this.setFilter({ tags: [renamed] });
          },
        },
        '-',
        { icon: 'trash', label: t('lib.deleteTag'), danger: true, run: () => actions.removeTag(name) },
      ],
    });
  }

  renderContent() {
    this.paintCounts();
    const { view, games, categories, tags } = this.filter;
    const current = VIEWS.find((v) => v.id === view);
    const total = this.visible.reduce((sum, clip) => sum + clip.duration, 0);
    const size = this.visible.reduce((sum, clip) => sum + clip.size, 0);
    const count = t('lib.clipCount', { count: this.visible.length });
    const folder = categories.length > 0;
    const scoped = null;
    const main = (folder ? categories : games).join(' + ') || (tags.length ? t('lib.tags') : scoped || current.title || current.label);
    const tagged = tags.length ? `${folder || games.length ? ' · ' : ' '}${tags.map((tag) => `#${tag}`).join(', ')}` : '';
    this.heading.replaceChildren(...[folder && icon('category'), tags.length && !folder && !games.length ? tagged.trim() : main + tagged].filter(Boolean));
    this.heading.classList.toggle('folder', folder);
    this.heading.dataset.tip = this.heading.textContent;
    this.summary.textContent = `${count}, ${format.duration(total)}, ${format.bytes(size)}`;

    const groups = new Map();
    const byDay = this.sort === 'newest' || this.sort === 'oldest';
    for (const clip of this.visible) {
      const key = byDay ? format.day(clip.date) : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(clip);
    }

    // Scans repeat while OBS records: rebuilding would lose double-clicks and previews.
    const shown = JSON.stringify([this.layout, this.sort, this.visible, this.app.state.scanned, [...groups.keys()],
      this.app.state.categories, this.app.state.logos, !this.visible.length && this.filter]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.cards.clear();
    const scroll = this.content.scrollTop;
    let views = [this.empty()];
    if (this.visible.length && this.layout === 'list') {
      views = [listHead(this), h('div', { class: 'list-body', role: 'rowgroup' }, this.visible.map((clip) => this.rowFor(clip)))];
    } else if (this.visible.length) {
      views = [...groups].map(([name, clips]) => h('section', { class: 'day' },
        h('h3', {}, name),
        h('div', { class: 'shelf' }, clips.map((clip) => this.cardFor(clip)))));
    }
    this.content.replaceChildren(...views);
    this.paintSelection();
    this.content.scrollTop = scroll;
    // A new export or a finished scan must not cut the preview under the pointer. Moved, it paused.
    const previewed = this.preview && this.cards.get(this.preview.clip.id);
    if (previewed) this.preview.moveTo(previewed.querySelector('.thumb'));
    else this.stopPreview();
  }

  empty() {
    if (!this.app.state.scanned) return h('div', { class: 'empty' }, h('b', {}, t('lib.reading')));
    const none = !this.app.state.clips.length;
    if (none) {
      return h('div', { class: 'empty' },
        h('b', {}, t('lib.noClips')),
        t('lib.addObsFolder'));
    }
    const { query } = this.filter;
    return h('div', { class: 'empty' },
      h('b', {}, query.trim() ? t('lib.nothingFor', { query: query.trim() }) : t('lib.nothing')),
      h('p', {}, t('lib.filterHides')),
      button({ icon: 'close', label: t('lib.showAll'), class: 'reset-filters', onClick: () => this.clearFilters() }));
  }

  /** Reuses the element while nothing changed for this clip. */
  cardFor(clip) {
    const state = JSON.stringify([clip, this.app.state.categories, this.app.state.logos]);
    let built = this.built.get(clip.id);
    if (built?.state !== state) {
      built = { state, el: this.card(clip) };
      this.built.set(clip.id, built);
    }
    this.cards.set(clip.id, built.el);
    return built.el;
  }

  card(clip) {
    const playable = !clip.busy && !clip.broken;
    let status = null;
    if (clip.busy) status = [t('card.writing'), 'refresh'];
    else if (clip.broken) status = [t('card.broken'), 'close'];
    else if (clip.edit) status = [t('card.edited'), 'scissors'];
    else if (clip.exported) status = [t('card.export'), 'output'];

    const counts = counted(clip);
    const multi = multiKill(counts.best);
    const tallies = ['kill', 'death'].filter((kind) => !clip.hideTallies && counts[kind]).map((kind) => h('span', {
      class: `tally ${kind}`,
      style: { '--tint': `var(--${KINDS[kind].color})` },
      title: t(kind === 'kill' ? 'card.kills' : 'card.deaths', { count: counts[kind] }),
    }, icon(KINDS[kind].icon), String(counts[kind])));
    if (!clip.hideTallies && counts.best >= 3) {
      tallies.unshift(h('span', {
        class: `tally multi ${counts.best >= 5 ? 'ace' : ''}`,
        title: t('card.roundKills', { count: counts.best }),
      }, multi));
    }

    // Opens the replays that share its pictures.
    const duplicate = playable && clip.duplicate && h('button', {
      class: 'badge duplicate',
      title: t('dup.badgeTitle', { count: clip.duplicate.others, time: format.seconds(clip.duplicate.shared) }),
      tabindex: -1,
      onClick: (event) => {
        event.stopPropagation();
        openDuplicates(this.app, [clip.id]);
      },
      onDblclick: (event) => event.stopPropagation(),
    }, icon('duplicate'), t('dup.badge'));

    const thumb = h('div', { class: 'thumb' },
      playable && h('img', {
        // The address changes with the chosen picture, so that the page does not show the old one.
        src: `/thumb/${clip.id}?${clip.key}${clip.thumb === null ? '' : `-${clip.thumb}`}`,
        loading: 'lazy',
        draggable: 'false',
        alt: '',
        onError: (event) => event.target.remove(),
      }),
      playable && h('span', { class: 'badge length' }, format.duration(clip.duration)),
      tallies.length > 0 && h('span', { class: 'tallies' }, tallies),
      (status || duplicate) && h('span', { class: 'badges' },
        status && h('span', { class: 'badge state' }, icon(status[1]), status[0]),
        duplicate),
      playable && h('button', {
        class: `heart ${clip.favorite ? 'on' : ''}`,
        title: t('lib.favorite'),
        tabindex: -1,
        onClick: (event) => {
          event.stopPropagation();
          this.app.actions.favorite([clip]);
        },
        onDblclick: (event) => event.stopPropagation(),
      }, icon(clip.favorite ? 'heartOn' : 'heart')));
    if (playable) this.keepPreview(clip, thumb);

    const el = h('article', {
      class: 'card',
      tabindex: 0,
      'data-id': clip.id,
      'aria-label': format.title(clip),
      ...this.clipHandlers(clip, playable),
      onPointerenter: () => playable && this.startPreview(clip, thumb),
      // A card that was rebuilt still gets this event, while its preview plays on in the new one.
      onPointerleave: (event) => event.currentTarget.isConnected && this.stopPreview(),
    },
    thumb,
    h('div', { class: 'label' },
      h('div', { class: 'card-title' },
        clip.game && h('span', { class: 'card-game', title: clip.game }, gameBadge(clip.game, this.app.state.logos)),
        h('b', {}, format.title(clip))),
      h('small', {},
        format.bytes(clip.size),
        clip.height && h('span', {}, `${clip.height}p${Math.round(clip.fps)}`),
        clip.audio.length > 1 && h('span', { class: 'tracks', title: t('card.tracks') }, icon('wave'), t('card.trackCount', { count: clip.audio.length }))),
      (clip.category || clip.tags.length > 0) && this.labels(clip)));

    return el;
  }

  /** Clicks, menu and drag of a clip, the same for a card and a row of the list. */
  clipHandlers(clip, playable) {
    return {
      onClick: (event) => this.click(clip, event),
      onDblclick: () => this.open(clip.id),
      onFocus: () => { this.focused = clip.id; },
      onContextmenu: (event) => this.menu(clip, event),
      onPointerdown: (event) => {
        if (!playable || event.target.closest('button')) return;
        const ids = this.selected.has(clip.id) ? [...this.selected] : [clip.id];
        startDrag(event, {
          payload: ids,
          label: ids.length > 1 ? t('lib.clipCount', { count: ids.length }) : format.title(clip),
          symbol: 'film',
          accepts: CLIP_TARGETS,
          onDrop: (dragged, target) => this.dropClips(dragged, target),
          // Out of the window: a file drag, to drop the clips into Discord or the Explorer.
          onLeave: (dragged) => {
            this.stopPreview();
            window.bridge.drag(dragged);
          },
        });
      },
    };
  }

  /** A row of the list view. */
  rowFor(clip) {
    const playable = !clip.busy && !clip.broken && clip.key;
    const row = listRow(this, clip, this.clipHandlers(clip, playable));
    this.cards.set(clip.id, row);
    return row;
  }

  /** The category and the tags of a card: a click filters on them. */
  labels(clip) {
    const { categories = [] } = this.app.state;
    const filterOn = (change) => ({
      onClick: (event) => {
        event.stopPropagation();
        this.setFilter(change);
      },
      onDblclick: (event) => event.stopPropagation(),
      tabindex: -1,
    });
    const more = clip.tags.slice(CARD_TAGS);
    return h('div', { class: 'card-labels' },
      clip.category && h('button', {
        class: 'card-category',
        style: { '--tint': `var(--${categoryColor(categories, clip.category)})` },
        title: t('lib.see', { name: clip.category }),
        onClick: (event) => {
          event.stopPropagation();
          this.openFolder(clip.category, event);
        },
        onDblclick: (event) => event.stopPropagation(),
        tabindex: -1,
      }, icon('category'), h('span', {}, clip.category)),
      clip.tags.slice(0, CARD_TAGS).map((tag) => h('button', {
        class: 'card-tag',
        title: t('lib.seeTag', { tag }),
        onClick: (event) => {
          event.stopPropagation();
          this.chooseTag(tag, event);
        },
        onDblclick: (event) => event.stopPropagation(),
        tabindex: -1,
      }, `#${tag}`)),
      more.length > 0 && h('span', { class: 'card-more', title: more.join(', ') }, `+${more.length}`));
  }

  open(id) {
    this.app.openClip(id, this.visible.filter((c) => !c.busy && !c.broken).map((c) => c.id));
  }

  /** Clips dropped on a folder, a tag, a game or the favourites. */
  async dropClips(ids, target) {
    const clips = ids.map((id) => this.app.clip(id)).filter(Boolean);
    if (!clips.length) return;
    const { category, tag, game } = target.dataset;
    if (category !== undefined) {
      await this.app.actions.setCategory(clips, category);
      toast(t('lib.filed', { count: clips.length, name: category }));
    } else if (tag !== undefined) {
      await call('update', ids, { addTags: [tag] });
      toast(t('lib.tagAdded', { tag, count: 1 }));
    } else if (game !== undefined) {
      await call('update', ids, { game: game === OTHER ? '' : game });
      toast(t('lib.gameChanged', { count: clips.length, game }));
    } else if (target.classList.contains('favorites')) {
      await call('update', ids, { favorite: true });
      toast(t('lib.favorited'));
    }
  }

  /** A tag dropped on a clip: on it, or on every selected clip when it is one of them. */
  async dropTag(tag, card) {
    const id = card.dataset.id;
    const ids = this.selected.has(id) ? [...this.selected] : [id];
    await call('update', ids, { addTags: [tag] });
    toast(t('lib.tagAdded', { tag, count: ids.length }));
  }

  click(clip, event) {
    if (event.shiftKey && this.anchor) {
      const order = this.visible.map((c) => c.id);
      const from = order.indexOf(this.anchor);
      const to = order.indexOf(clip.id);
      if (from >= 0) {
        this.select(order.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
    }
    this.anchor = clip.id;
    if (event.ctrlKey) {
      const next = new Set(this.selected);
      if (next.has(clip.id)) next.delete(clip.id);
      else next.add(clip.id);
      this.select(next);
    } else {
      this.select([clip.id]);
    }
  }

  select(ids) {
    this.selected = new Set(ids);
    this.paintSelection();
  }

  selection() {
    return this.app.state.clips.filter((clip) => this.selected.has(clip.id));
  }

  /** The clips shown and selected, in the status bar. */
  paintCounts() {
    const shown = t('lib.clipCount', { count: this.visible.length });
    const selected = this.visible.filter((clip) => this.selected.has(clip.id)).length;
    this.app.status?.set('counts', selected ? `${shown} · ${t('lib.selected', { count: selected })}` : shown);
  }

  paintSelection() {
    for (const [id, el] of this.cards) el.classList.toggle('selected', this.selected.has(id));
    const clips = this.selection();
    this.bar.hidden = !clips.length;
    this.paintCounts();
    this.renderInfo();
    if (!clips.length) return;

    const { actions } = this.app;
    const one = clips.length === 1;
    this.bar.replaceChildren(...[
      h('b', {}, t('lib.selected', { count: clips.length })),
      one && button({ icon: 'scissors', label: t('lib.edit'), class: 'primary', onClick: () => this.open(clips[0].id) }),
      button({
        icon: clips.every((c) => c.favorite) ? 'heartOn' : 'heart',
        title: t('lib.favorite'),
        class: `ghost ${clips.every((c) => c.favorite) ? 'loved' : ''}`,
        onClick: () => actions.favorite(clips),
      }),
      one && button({ icon: 'title', title: t('lib.nameKey'), class: 'ghost', onClick: () => actions.name(clips[0]) }),
      button({
        icon: 'category',
        title: t('lib.categoryKey'),
        class: 'ghost pick-category',
        onClick: (event) => pickCategory(this.app, clips, { anchor: event.currentTarget, keyboard: event.detail === 0 }),
      }),
      button({ icon: 'tag', title: t('lib.tagsKey'), class: 'ghost', onClick: () => actions.tag(clips) }),
      button({ icon: 'game', title: t('lib.chooseGame'), class: 'ghost', onClick: () => actions.game(clips) }),
      button({ icon: 'trash', title: t('lib.trashKey'), class: 'ghost danger', onClick: () => actions.trash(clips) }),
      button({ icon: 'close', title: t('lib.deselect'), class: 'ghost', onClick: () => this.select([]) }),
    ].filter(Boolean));
  }

  menu(clip, event) {
    event.preventDefault();
    if (!this.selected.has(clip.id)) this.select([clip.id]);
    const clips = this.selection();
    const { actions } = this.app;
    const one = clips.length === 1;
    showMenu({
      x: event.clientX,
      y: event.clientY,
      title: one ? format.title(clip) : t('lib.clipCount', { count: clips.length }),
      items: [
        one && { icon: 'scissors', label: t('lib.edit'), hint: t('key.enter'), run: () => this.open(clip.id) },
        {
          icon: 'heart',
          tint: 'liked',
          hint: 'F',
          label: clips.every((c) => c.favorite) ? t('lib.unfavorite') : t('lib.addFavorite'),
          run: () => actions.favorite(clips),
        },
        '-',
        one && { icon: 'title', label: t('lib.name'), hint: 'F2', run: () => actions.name(clip) },
        {
          icon: 'category',
          label: t('lib.categoryMenu'),
          hint: 'C',
          run: () => pickCategory(this.app, clips, { x: event.clientX, y: event.clientY }),
        },
        { icon: 'game', label: t('lib.chooseGame'), run: () => actions.game(clips) },
        { icon: 'tag', label: t('lib.tagsMenu'), hint: 'T', run: () => actions.tag(clips) },
        clips.some((c) => c.moments.some((m) => m.kind !== 'mark')) && {
          icon: 'crosshair',
          label: clips.every((c) => c.hideTallies) ? t('lib.showTallies') : t('lib.hideTallies'),
          detail: t('lib.onThumbnail'),
          run: () => call('update', clips.map((c) => c.id), { hideTallies: !clips.every((c) => c.hideTallies) }),
        },
        clips.some((c) => c.thumb !== null) && {
          icon: 'reset',
          label: t('editor.defaultThumb'),
          run: () => call('update', clips.filter((c) => c.thumb !== null).map((c) => c.id), { thumb: null }),
        },
        ...(one ? clip.tags : []).map((tag) => ({
          icon: 'close',
          label: t('lib.untag', { tag }),
          run: () => actions.untag(clips, tag),
        })),
        '-',
        one && { icon: 'pencil', label: t('lib.renameFile'), run: () => actions.rename(clip) },
        one && { icon: 'folder', label: t('lib.reveal'), run: () => actions.reveal(clip) },
        one && { icon: 'copy', label: t('lib.copyPath'), run: () => actions.copyPath(clip) },
        one && {
          icon: 'discord',
          label: t('discord.export'),
          detail: t('discord.ready'),
          run: () => openDiscord(clip),
        },
        clips.some(compressible) && {
          icon: 'compress',
          label: t('storage.compressMenu'),
          detail: t('storage.half'),
          run: () => openStorage(this.app, clips.map((c) => c.id)),
        },
        clips.some((c) => c.duplicate) && {
          icon: 'duplicate',
          label: t('dup.menu'),
          detail: one ? t('dup.menuDetail', { time: format.seconds(clip.duplicate.shared) }) : undefined,
          run: () => openDuplicates(this.app, clips.map((c) => c.id)),
        },
        one && clip.hasPrevious && {
          icon: 'history',
          tint: 'accent',
          label: t('lib.revert'),
          run: async () => {
            if (await actions.confirmRevert()) await actions.revert(clip);
          },
        },
        '-',
        { icon: 'trash', label: t('lib.trash'), hint: t('key.delete'), danger: true, run: () => actions.trash(clips) },
      ],
    });
  }

  startPreview(clip, thumb) {
    if (this.preview?.clip.id === clip.id && thumb.contains(this.preview.el)) return;
    this.stopPreview();
    this.previewTimer = setTimeout(() => {
      // The card may have been rebuilt, or hidden, meanwhile.
      const now = this.cards.get(clip.id)?.querySelector('.thumb');
      if (!now) return;
      this.preview = new Preview(this.app.clip(clip.id) || clip);
      this.preview.moveTo(now);
    }, PREVIEW_DELAY);
  }

  /** A card rebuilt under the pointer keeps its preview where it was, unless its montage changed. */
  keepPreview(clip, thumb) {
    if (this.preview?.clip.id !== clip.id) return;
    if (JSON.stringify(this.preview.clip.edit) !== JSON.stringify(clip.edit)) {
      this.preview.dispose();
      this.preview = new Preview(clip);
    }
    this.preview.moveTo(thumb);
  }

  stopPreview() {
    clearTimeout(this.previewTimer);
    this.preview?.dispose();
    this.preview = null;
  }

  key(event) {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === 'i') {
      event.preventDefault();
      this.toggleInfo();
      return;
    }
    if (event.ctrlKey && key === 'f') {
      event.preventDefault();
      this.search.select();
      return;
    }
    if (event.target.matches('input')) {
      if (key === 'escape') event.target.blur();
      return;
    }
    if (event.ctrlKey && key === 'a') {
      event.preventDefault();
      this.select(this.visible.map((clip) => clip.id));
      return;
    }
    const clips = this.selection();
    if (key === 'f2' && clips.length === 1) {
      event.preventDefault();
      this.app.actions.name(clips[0]);
    } else if (key === 't' && !event.ctrlKey && clips.length) {
      event.preventDefault();
      this.app.actions.tag(clips);
    } else if (key === 'c' && !event.ctrlKey && clips.length) {
      event.preventDefault();
      const place = this.pointer
        ? { ...this.pointer, keyboard: true }
        : { anchor: this.bar.querySelector('.pick-category'), keyboard: true };
      pickCategory(this.app, clips, place);
    } else if (key === 'escape') this.select([]);
    else if (key === 'enter' && event.target.matches('.card, .list-row')) this.open(this.focused);
    else if (key === 'f' && clips.length) this.app.actions.favorite(clips);
    else if (key === 'delete' && clips.length) this.app.actions.trash(clips);
  }

  hide() {
    this.stopPreview();
    this.scroll = this.content.scrollTop;
    this.root.hidden = true;
  }

  show() {
    this.root.hidden = false;
    this.render();
    this.content.scrollTop = this.scroll || 0;
  }
}
