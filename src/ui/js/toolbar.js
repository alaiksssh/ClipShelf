// The two rows above the timeline: tools, then options that depend on the selection.
import { h, icon, button, slider, setSlider, remember, store } from './dom.js';
import * as format from './format.js';
import * as P from '/shared/pieces.mjs';
import { RATIOS } from '/shared/geometry.mjs';
import { STYLES } from './waveforms.js';
import { dropdown } from './menu.js';
import { KINDS, labelOf } from '/shared/moments.mjs';
import { MAX_VOLUME, zoneOf } from '/shared/edit.mjs';
import { timeField } from './timeField.js';
import { volumeField } from './volumeField.js';
import { t } from './i18n.js';

const RATIO_USES = { '16:9': 'YouTube', '9:16': 'TikTok, Shorts, Reels', '1:1': t('ratio.square') };

const TOOLS = [
  ['select', 'cursor', t('tool.select')],
  ['razor', 'razor', t('tool.razor')],
  ['razorTrack', 'razor', t('tool.razorTrack'), 'single'],
  ['range', 'range', t('tool.range')],
];

const HINTS = {
  select: t('hint.select'),
  razor: t('hint.razor'),
  razorTrack: t('hint.razorTrack'),
  range: t('hint.range'),
};

export class Toolbar {
  constructor(editor) {
    this.editor = editor;
    const { commands } = editor;
    const tool = (name, title, run, extra = '') =>
      button({ icon: name, title, class: `ghost ${extra}`, onClick: run });
    const sep = () => h('span', { class: 'sep' });

    this.play = button({ icon: 'play', title: t('tool.play'), class: 'play', onClick: () => editor.player.toggle() });
    this.time = timeField({
      player: editor.player,
      fps: editor.clip.fps || 30,
      onSeek: (time) => editor.timeline.reveal(time),
    });
    this.total = h('small');
    this.tools = TOOLS.map(([id, name, title, extra]) => [id, tool(name, title, () => editor.setTool(id), extra)]);
    this.magnet = tool('magnet', '', () => editor.setOption('magnet', !editor.magnet));
    this.link = tool('link', '', () => editor.setOption('linked', !editor.linked));
    this.undo = tool('undo', t('tool.undo'), () => editor.travel(-1));
    this.redo = tool('redo', t('tool.redo'), () => editor.travel(1));
    this.removedCount = h('span', { class: 'count' });
    this.removed = h('button', {
      class: 'btn ghost removed',
      hidden: true,
      title: t('tool.removedTitle'),
      'aria-haspopup': 'menu',
      onClick: (event) => editor.removedMenu({ anchor: this.removed, keyboard: event.detail === 0 }),
    }, icon('history'), h('span', {}, t('tool.removed')), this.removedCount);

    const skip = (seconds) => h('button', {
      class: 'btn ghost skip',
      title: seconds < 0 ? t('tool.back5') : t('tool.forward5'),
      onClick: () => editor.skip(seconds),
    }, icon(seconds < 0 ? 'rewind' : 'forward'), h('small', {}, seconds < 0 ? '−5 s' : '+5 s'));

    this.momentsCount = h('span', { class: 'count' });
    this.momentsList = h('button', {
      class: 'btn ghost moments-button',
      title: t('tool.moments'),
      'aria-haspopup': 'menu',
      onClick: (event) => editor.moments.list({ anchor: this.momentsList, keyboard: event.detail === 0 }),
    }, icon('crosshair'), h('span', {}, t('moments.title')), this.momentsCount);
    this.previous = tool('back', t('tool.previousMoment'), () => editor.moments.jump(-1), 'moment-step');
    this.next = tool('next', t('tool.nextMoment'), () => editor.moments.jump(1), 'moment-step');

    const main = h('div', { class: 'tools' },
      h('div', { class: 'transport' },
        tool('toStart', t('tool.toStart'), () => editor.player.seek(0), 'to-start'),
        skip(-5),
        this.play,
        skip(5),
        tool('toEnd', t('tool.toEnd'), () => editor.player.seek(editor.player.length), 'to-end')),
      h('span', { class: 'clock' }, ...this.time.els, this.total),
      h('div', { class: 'segmented' }, this.tools.map(([, el]) => el)),
      sep(),
      tool('scissors', t('tool.split'), () => commands.split()),
      tool('start', t('tool.zoneStart'), () => commands.zoneEdge('start')),
      tool('end', t('tool.zoneEnd'), () => commands.zoneEdge('end')),
      tool('duplicate', t('tool.duplicate'), () => commands.duplicate()),
      tool('trash', t('tool.delete'), () => commands.remove()),
      sep(),
      this.magnet,
      this.link,
      sep(),
      this.undo,
      this.redo,
      tool('reset', t('tool.reset'), () => editor.reset()),
      this.removed,
      h('div', { class: 'spacer' }),
      tool('zoomOut', t('tool.zoomOut'), () => editor.timeline.zoom(1 / 1.5)),
      tool('zoomIn', t('tool.zoomIn'), () => editor.timeline.zoom(1.5)),
      tool('fit', t('tool.fit'), () => editor.timeline.fit()));

    this.context = h('div', { class: 'context' });
    this.volume = this.volumeControl();

    this.ratio = dropdown({
      class: 'ratio',
      title: t('tool.ratio'),
      value: editor.edit.ratio,
      options: Object.keys(RATIOS).map((value) => ({
        value,
        icon: value === 'original' ? 'film' : 'crop',
        label: value === 'original' ? t('ratio.original') : value,
        detail: RATIO_USES[value],
      })),
      onChange: (ratio) => editor.change({ ratio }),
    });

    const style = dropdown({
      class: 'audio-style',
      title: t('tool.audioStyle'),
      value: editor.audioStyle,
      options: Object.entries(STYLES).map(([value, { label }]) => ({ value, label, icon: 'wave' })),
      onChange: (value) => editor.setOption('audioStyle', value),
    });

    const master = slider({
      class: 'master',
      min: 0, max: 1, step: 0.01,
      value: remember('volume', 1),
      title: t('tool.volume'),
      onInput: (value) => {
        editor.player.setVolume(value);
        store('volume', value);
      },
    });

    const moments = h('div', { class: 'moments-tools' }, this.previous, this.momentsList, this.next,
      tool('flag', t('tool.mark'), () => editor.moments.mark(), 'add-mark'));
    const options = h('div', { class: 'options' }, this.context, moments, this.ratio, style, icon('volume'), master);

    this.el = h('div', {
      // Keep the shortcuts working after a click on a button.
      onMousedown: (event) => {
        if (!event.target.closest('button')) return;
        event.preventDefault();
        if (document.activeElement?.matches('input')) document.activeElement.blur();
      },
    }, main, options);
  }

  /**
   * The volume of the selected pieces of sound, or of the selected passage. It is heard and drawn
   * while it moves, and recorded once let go. Its elements are kept when the row is rebuilt, so that
   * a double click still lands on them.
   */
  volumeControl() {
    const { editor } = this;
    // { value, base, piecesFor, commit, title } from `renderContext`, for what is selected now.
    let target = null;
    const same = (value) => Math.abs(value - target.value) < 1e-6;
    const preview = (value) => {
      if (target) editor.show(same(value) ? target.base : { ...target.base, pieces: target.piecesFor(value) });
    };
    const apply = (value) => {
      if (!target) return;
      const { base } = target;
      // Back to where it was is not a change: no step of the history, no "edited" clip.
      if (same(value)) {
        editor.restore(base);
        return;
      }
      editor.edit = base;
      target.commit(value);
    };
    const amount = volumeField({
      onPreview: (value) => {
        setSlider(range, value);
        preview(value);
      },
      onApply: (value) => {
        setSlider(range, value);
        apply(value);
      },
    });
    const range = slider({
      class: 'piece-volume',
      min: 0, max: MAX_VOLUME, step: 0.01, value: 1,
      onInput: (value) => {
        amount.set(value);
        preview(value);
      },
      onChange: () => apply(Number(range.value)),
      onDblclick: () => {
        setSlider(range, 1);
        amount.set(1);
        apply(1);
      },
    });
    const el = h('span', { class: 'volume-control' }, icon('volume'), range, amount.el);
    return {
      el,
      set(next) {
        target = next;
        setSlider(range, next.value);
        amount.set(next.value);
        el.dataset.tip = next.title;
      },
    };
  }

  showPlaying(playing) {
    this.play.replaceChildren(icon(playing ? 'pause' : 'play'));
  }

  showTime(time, length) {
    this.time.show(time);
    this.total.textContent = ` / ${format.duration(length, 2)}`;
  }

  update() {
    const { editor } = this;
    for (const [id, el] of this.tools) el.classList.toggle('active', editor.tool === id);

    const toggle = (el, on, name) => {
      el.classList.toggle('active', on);
      el.dataset.tip = t(on ? 'tool.on' : 'tool.off', { name });
      el.setAttribute('aria-pressed', String(on));
      el.setAttribute('aria-label', el.title);
    };
    toggle(this.magnet, editor.magnet, t('tool.magnet'));
    toggle(this.link, editor.linked, t('tool.link'));

    this.undo.disabled = !editor.canTravel(-1);
    this.redo.disabled = !editor.canTravel(1);
    this.ratio.value = editor.edit.ratio;
    const removed = editor.commands.removed().length;
    this.removed.hidden = !removed && !editor.clip.hasPrevious;
    this.removedCount.hidden = !removed;
    this.removedCount.textContent = String(removed);

    const placed = editor.moments.placed();
    const waiting = editor.clip.game.toLowerCase() === 'valorant' && !editor.clip.detected
      && editor.app.state.detection?.on;
    this.momentsCount.textContent = waiting ? '…' : String(placed.length);
    this.previous.disabled = !placed.length;
    this.next.disabled = !placed.length;
    this.renderContext();
  }

  /** The volume control, set for the selected pieces of sound. */
  pieceVolume(piece) {
    const { editor } = this;
    const { commands } = editor;
    const base = editor.edit;
    const ids = new Set(commands.volumeTargets().map((p) => p.id));
    this.volume.set({
      value: P.volumeOf(piece),
      base,
      piecesFor: (value) => P.setVolume(base.pieces, ids, value),
      commit: (value) => commands.pieceVolume(value),
      title: ids.size > 1 ? t('piece.volumeMany', { count: ids.size }) : t('piece.volumeTitle', { track: editor.trackName(piece.lane) }),
    });
    return this.volume.el;
  }

  /** The volume control, set for the selected passage. */
  rangeVolume() {
    const { editor } = this;
    const { commands, selection } = editor;
    const lanes = commands.rangeLanes();
    const [start, end] = selection.range;
    const under = P.pieceAt(editor.edit.pieces, lanes[0], (start + end) / 2);
    const base = editor.edit;
    this.volume.set({
      value: under ? P.volumeOf(under) : 1,
      base,
      piecesFor: (value) => P.volumeRange(base.pieces, lanes, selection.range, value),
      commit: (value) => commands.rangeVolume(value),
      title: selection.lane === P.VIDEO
        ? t('range.volumeAll')
        : t('range.volumeTitle', { track: editor.trackName(selection.lane) }),
    });
    return this.volume.el;
  }

  renderContext() {
    const { editor } = this;
    const { commands, selection } = editor;
    // What the tool does stays in the status bar; this row keeps the actions on what is selected.
    editor.app.status?.set('hint', HINTS[editor.tool]);
    const action = (name, label, run, extra = '', title = label) =>
      button({ icon: name, label, title, class: extra, onClick: run });

    if (selection?.type === 'range') {
      const [a, b] = selection.range;
      const picture = selection.lane === P.VIDEO;
      this.context.replaceChildren(...[
        h('b', {}, t('editor.span', { from: format.duration(a, 1), to: format.duration(b, 1) })),
        action('muted', t('range.mute'), () => commands.muteRange(), '', t('range.muteTitle')),
        !picture && editor.edit.tracks.length > 1
          && action('muted', t('range.muteAll'), () => commands.muteRange(true), '', t('range.muteAllTitle')),
        editor.edit.tracks.length > 0 && this.rangeVolume(),
        action('scissors', t('range.isolate'), () => commands.isolateRange(), '', t('range.isolateTitle')),
        action('check', t('range.keep'), () => commands.keepRange(), '', t('range.keepTitle')),
        action('trash', t('common.delete'), () => commands.remove(), 'danger',
          t(picture ? 'range.deleteAll' : 'range.deleteOne')),
      ].filter(Boolean));
      return;
    }

    if (selection?.type === 'moment') {
      const item = editor.moments.selected();
      if (item) {
        this.context.replaceChildren(
          h('b', {}, `${labelOf(item, t) || t(KINDS[item.moment.kind].name)}, ${format.duration(item.at, 1)}`),
          action('title', item.moment.name ? t('common.rename') : t('lib.name'), () => editor.moments.name(item), '', t('moment.nameTitle')),
          item.moment.kind === 'mark' && action('flag', t('moment.color'), (event) => editor.moments.menu(item, { anchor: event.currentTarget }), '', t('moment.colorTitle')),
          action('trash', t('common.remove'), () => editor.moments.remove(item), 'danger', t('moment.removeTitle')));
        return;
      }
    }
    const piece = commands.active();
    const zone = zoneOf(editor.edit);
    if (!piece && zone) {
      this.context.replaceChildren(
        h('b', { class: 'zone-label' }, t('zone.label', { from: format.duration(zone[0], 2), to: format.duration(zone[1], 2) })),
        h('span', {}, t('zone.length', { length: format.seconds(zone[1] - zone[0]) })),
        action('close', t('zone.remove'), () => commands.clearZone(), '', t('zone.removeTitle')));
      return;
    }
    if (!piece) {
      this.context.replaceChildren();
      return;
    }
    const picture = piece.lane === P.VIDEO;
    const values = [...new Set([...P.SPEEDS, piece.speed])].sort((a, b) => a - b);
    const speed = dropdown({
      class: 'speed',
      title: t('piece.speed'),
      value: piece.speed,
      options: values.map((value) => ({ value, label: t('piece.speedValue', { n: Number(value.toFixed(2)) }) })),
      onChange: (value) => commands.speed(value),
    });

    const shared = selection.linked && editor.edit.pieces.some((p) => p.id !== piece.id && p.group === piece.group);
    this.context.replaceChildren(...[
      h('b', {}, `${picture ? t('editor.video') : editor.trackName(piece.lane)}, ${format.duration(P.lengthOf(piece), 2)}`),
      speed,
      !picture && this.pieceVolume(piece),
      !picture && action(piece.muted ? 'volume' : 'muted', piece.muted ? t('editor.unmute') : t('range.mute'),
        () => commands.toggleMuted(), '', t('piece.muteTitle')),
      !picture && shared && action('link', t('piece.unlink'), () => commands.unlink(), '', t('piece.unlinkTitle')),
    ].filter(Boolean));
  }
}
