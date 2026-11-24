// The list view of the library (one row per clip, columns that sort) and the info panel of the
// selected clips. Rows take the same clicks, menus and drags as cards; they play no preview.
import { h, icon, call } from './dom.js';
import * as format from './format.js';
import { t, decimal } from './i18n.js';
import { gameBadge } from './gameBadge.js';
import { countMoments } from '/shared/moments.mjs';

/** Columns of the list: [class, heading, sort when clicked, sort when clicked again]. */
const COLUMNS = [
  ['title', t('list.title'), 'name', 'name'],
  ['game', t('list.game'), null, null],
  ['duration', t('list.duration'), 'longest', 'shortest'],
  ['size', t('list.size'), 'largest', 'largest'],
  ['quality', t('list.quality'), null, null],
  ['date', t('list.date'), 'newest', 'oldest'],
];

const quality = (clip) => (clip.height ? `${clip.height}p${Math.round(clip.fps)}` : '');

export function listHead(library) {
  return h('div', { class: 'list-head', role: 'row' }, h('span', { class: 'list-thumb' }),
    ...COLUMNS.map(([name, label, first, second]) => {
      const on = Boolean(first) && (library.sort === first || library.sort === second);
      const reversed = on && library.sort === second && second !== first;
      return h(first ? 'button' : 'span', {
        class: `list-col list-${name} ${on ? 'sorted' : ''} ${reversed ? 'reversed' : ''}`,
        onClick: first ? () => library.setSort(library.sort === first && second !== first ? second : first) : undefined,
      }, label, on && icon('down'));
    }),
    h('span', { class: 'list-col list-tags' }, t('lib.tags')));
}

export function listRow(library, clip, handlers) {
  const { logos } = library.app.state;
  const playable = !clip.busy && !clip.broken && clip.key;
  return h('div', {
    class: 'list-row',
    role: 'row',
    tabindex: 0,
    'data-id': clip.id,
    'aria-label': format.title(clip),
    ...handlers,
  },
  h('span', { class: 'list-thumb' }, playable && h('img', {
    src: `/thumb/${clip.id}?${clip.key}${clip.thumb === null ? '' : `-${clip.thumb}`}`,
    loading: 'lazy',
    draggable: 'false',
    alt: '',
    onError: (event) => event.target.remove(),
  })),
  h('span', { class: 'list-col list-title' }, clip.favorite && icon('heartOn'), h('b', {}, format.title(clip))),
  h('span', { class: 'list-col list-game' }, clip.game && gameBadge(clip.game, logos), clip.game || ''),
  h('span', { class: 'list-col list-duration' }, format.duration(clip.duration)),
  h('span', { class: 'list-col list-size' }, format.bytes(clip.size)),
  h('span', { class: 'list-col list-quality' }, quality(clip)),
  h('span', { class: 'list-col list-date' }, format.when(clip.date)),
  h('span', { class: 'list-col list-tags' }, clip.tags.map((tag) => `#${tag}`).join(' ')));
}

const row = (label, value) => value !== '' && value !== null && value !== undefined
  && [h('dt', {}, label), h('dd', {}, value)];

/** What the info panel shows: one clip in detail, or the sum of several. */
export function infoPanel(app, clips) {
  if (!clips.length) return [h('p', { class: 'info-empty' }, icon('info'), t('info.none'))];
  if (clips.length > 1) {
    const duration = clips.reduce((sum, clip) => sum + clip.duration, 0);
    const size = clips.reduce((sum, clip) => sum + clip.size, 0);
    return [
      h('h2', {}, t('lib.selected', { count: clips.length })),
      h('dl', {}, ...[row(t('list.duration'), format.duration(duration)), row(t('list.size'), format.bytes(size))].flat().filter(Boolean)),
    ];
  }
  const [clip] = clips;
  const counts = countMoments(clip.moments, clip.rounds);
  const bitrate = clip.duration > 0 ? `${Math.round((clip.size * 8) / clip.duration / 1e6)} Mbit/s` : '';
  const moments = [counts.kill && t('info.kills', { count: counts.kill }), counts.death && t('info.deaths', { count: counts.death }),
    counts.mark && t('info.marks', { count: counts.mark })].filter(Boolean).join(', ');
  const tracks = clip.audio.map((track, i) => track.name || t('info.track', { n: i + 1 }));
  const playable = !clip.busy && !clip.broken && clip.key;
  return [
    playable && h('img', { class: 'info-thumb', src: `/thumb/${clip.id}?${clip.key}${clip.thumb === null ? '' : `-${clip.thumb}`}`, alt: '' }),
    h('h2', {}, format.title(clip)),
    h('p', { class: 'info-file' }, clip.name),
    h('dl', {}, ...[
      row(t('list.game'), clip.game || ''),
      row(t('list.date'), format.when(clip.date)),
      row(t('list.duration'), format.duration(clip.duration, 1)),
      row(t('list.size'), format.bytes(clip.size)),
      row(t('info.picture'), clip.width ? `${clip.width}×${clip.height}, ${t('info.fps', { fps: decimal(clip.fps, Number.isInteger(Math.round(clip.fps * 100) / 100) ? 0 : 2) })}` : ''),
      row(t('info.codec'), [clip.codec?.toUpperCase(), bitrate].filter(Boolean).join(', ')),
      row(t('info.tracks'), tracks.length ? tracks.join(', ') : t('info.noTrack')),
      row(t('info.category'), clip.category || ''),
      row(t('lib.tags'), clip.tags.map((tag) => `#${tag}`).join(' ')),
      row(t('info.moments'), moments),
    ].flat().filter(Boolean)),
    h('p', { class: 'info-path' }, clip.path),
    h('div', { class: 'info-actions' },
      h('button', { class: 'btn ghost', onClick: () => call('copyPath', clip.id) }, icon('copy'), t('lib.copyPath')),
      h('button', { class: 'btn ghost', onClick: () => call('reveal', clip.id) }, icon('folder'), t('lib.reveal'))),
  ];
}
