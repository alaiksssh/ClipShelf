// The clip alone over the whole screen (double-click on the video, F11 or Alt+Enter in the editor).
// Its controls show while the pointer moves and hide while it plays. A pointer resting at the
// bottom brings an arrow that opens the kills, deaths and marks; resting at the right, one that
// opens the details of the clip. Both stay open or closed from one time to the next.
import { h, icon, button, remember, store } from './dom.js';
import * as format from './format.js';
import { clamp } from '/shared/geometry.mjs';
import { KINDS, colorOf, labelOf, placeMoments } from '/shared/moments.mjs';
import { infoPanel } from './clipViews.js';
import { t } from './i18n.js';

// The controls hide once the pointer rests that long, while the clip plays.
const CONTROLS_DELAY = 2500;
// A pointer resting that long near an edge brings the arrow of that edge.
const REST = 450;
// How far from an edge the pointer counts as near it, in pixels.
const RIGHT_ZONE = 110;
const BOTTOM_ZONE = 150;

// The stage under them plays, pauses and leaves on clicks: they keep their clicks to themselves.
const own = { onClick: (event) => event.stopPropagation(), onDblclick: (event) => event.stopPropagation() };

export class VideoAlone {
  constructor(editor) {
    this.editor = editor;
    this.momentsOpen = Boolean(remember('videoMoments', false));
    this.detailsOpen = Boolean(remember('videoDetails', false));
    this.zone = '';
    this.shownMoments = '';
    this.shownDetails = '';
    this.build();
  }

  get on() {
    return this.editor.videoOnly;
  }

  build() {
    const { editor } = this;
    const { player } = editor;
    const skip = (seconds) => h('button', {
      class: 'btn ghost skip',
      title: seconds < 0 ? t('tool.back5') : t('tool.forward5'),
      onClick: () => editor.skip(seconds),
    }, icon(seconds < 0 ? 'rewind' : 'forward'), h('small', {}, seconds < 0 ? '−5 s' : '+5 s'));
    this.play = button({ icon: 'play', title: t('tool.play'), class: 'play', onClick: () => player.toggle() });
    this.time = h('span', { class: 'video-time' });
    this.fill = h('div', { class: 'seek-fill' });
    this.ticks = h('div', { class: 'seek-ticks' });
    const seek = h('div', { class: 'seek', onPointerdown: (event) => this.dragSeek(event) }, this.ticks, this.fill);
    this.momentsRow = h('div', { class: 'video-moments' });
    this.bottomTab = h('button', {
      class: 'drawer-tab bottom',
      title: t('video.momentsTab'),
      ...own,
      onClick: (event) => {
        event.stopPropagation();
        this.setMoments(!this.momentsOpen);
      },
    }, icon('down'));
    this.controls = h('div', { class: 'video-controls', ...own },
      this.bottomTab,
      this.momentsRow,
      h('div', { class: 'video-transport' },
        button({ icon: 'toStart', title: t('tool.toStart'), class: 'ghost', onClick: () => player.seek(0) }),
        skip(-5),
        this.play,
        skip(5),
        button({ icon: 'toEnd', title: t('tool.toEnd'), class: 'ghost', onClick: () => player.seek(player.length) })),
      this.time,
      seek,
      button({ icon: 'cornersIn', title: t('editor.videoLeave'), class: 'ghost', onClick: () => editor.setVideoOnly(false) }));

    this.details = h('aside', { class: 'video-details info-panel', ...own });
    this.sideTab = h('button', {
      class: 'drawer-tab right',
      title: t('video.detailsTab'),
      ...own,
      onClick: (event) => {
        event.stopPropagation();
        this.setDetails(!this.detailsOpen);
      },
    }, icon('back'));
    this.enlarge = button({
      icon: 'cornersOut',
      title: t('editor.videoFull'),
      class: 'stage-full',
      ...own,
      onClick: (event) => {
        event.stopPropagation();
        editor.setVideoOnly(true);
      },
    });
    this.els = [this.enlarge, this.details, this.sideTab, this.controls];
  }

  /** Called when the editor enters or leaves the video alone. */
  enter() {
    this.paint();
    this.showTime();
    this.showPlaying(this.editor.player.playing);
  }

  leave() {
    clearTimeout(this.sleepTimer);
    clearTimeout(this.restTimer);
    this.zone = '';
    this.editor.stage.classList.remove('awake', 'near-right', 'near-bottom');
  }

  /** Open drawers and their contents follow the clip and its montage. */
  paint() {
    const { stage } = this.editor;
    stage.classList.toggle('moments-open', this.momentsOpen);
    stage.classList.toggle('details-open', this.detailsOpen);
    this.paintMoments();
    this.paintDetails();
  }

  setMoments(open) {
    this.momentsOpen = open;
    store('videoMoments', open);
    this.paint();
    this.wake();
  }

  setDetails(open) {
    this.detailsOpen = open;
    store('videoDetails', open);
    this.paint();
    this.wake();
  }

  paintMoments() {
    if (!this.on) return;
    const { clip, edit, player } = this.editor;
    const placed = placeMoments(clip.moments, edit.pieces);
    const { length } = player;
    const shown = JSON.stringify([length, placed.map(({ id, at, moment, number }) => [id, at, moment.kind, moment.name, moment.color, number])]);
    if (shown === this.shownMoments) return;
    this.shownMoments = shown;
    const left = (at) => `${length ? clamp(at / length, 0, 1) * 100 : 0}%`;
    this.ticks.replaceChildren(...placed.map((item) => h('span', {
      class: `seek-tick ${item.moment.kind}`,
      style: { left: left(item.at), '--tint': `var(--${colorOf(item.moment)})` },
    })));
    this.momentsRow.replaceChildren(...(placed.length
      ? placed.map((item) => {
        const label = labelOf(item, t) || t(KINDS[item.moment.kind].name);
        return h('button', {
          class: `video-moment ${item.moment.kind}`,
          style: { left: left(item.at), '--tint': `var(--${colorOf(item.moment)})` },
          title: `${label}\n${format.duration(item.at, 1)}`,
          'aria-label': label,
          onMousedown: (event) => event.preventDefault(), // The keys keep working.
          onClick: () => this.editor.goToMoment(item),
        }, icon(KINDS[item.moment.kind].icon));
      })
      : [h('p', { class: 'video-moments-empty' }, t('video.noMoments'))]));
  }

  paintDetails() {
    if (!this.on || !this.detailsOpen) return;
    const { clip } = this.editor;
    const shown = JSON.stringify([clip, this.editor.app.state.logos]);
    if (shown === this.shownDetails) return;
    this.shownDetails = shown;
    this.details.replaceChildren(...infoPanel(this.editor.app, [clip]).filter(Boolean));
  }

  showTime() {
    if (!this.on) return;
    const { time, length } = this.editor.player;
    this.time.textContent = `${format.duration(time, 1)} / ${format.duration(length, 1)}`;
    this.fill.style.width = `${length ? clamp(time / length, 0, 1) * 100 : 0}%`;
  }

  showPlaying(playing) {
    this.play.replaceChildren(icon(playing ? 'pause' : 'play'));
    this.wake();
  }

  dragSeek(event) {
    if (event.button !== 0) return;
    const { editor } = this;
    const bar = event.currentTarget;
    const go = (at) => {
      const { left, width } = bar.getBoundingClientRect();
      editor.player.seek(clamp((at.clientX - left) / width, 0, 1) * editor.player.length);
      editor.timeline.reveal(editor.player.time);
    };
    bar.setPointerCapture(event.pointerId);
    go(event);
    const end = () => {
      bar.removeEventListener('pointermove', go);
      bar.removeEventListener('lostpointercapture', end);
    };
    bar.addEventListener('pointermove', go);
    bar.addEventListener('lostpointercapture', end);
  }

  /** The pointer moved over the stage: the controls show, and an edge it rests near shows its arrow. */
  point(event) {
    if (!this.on) return;
    this.wake();
    const { stage } = this.editor;
    const box = stage.getBoundingClientRect();
    let zone = '';
    if (box.right - event.clientX < RIGHT_ZONE + (this.detailsOpen ? this.details.offsetWidth : 0)) zone = 'right';
    else if (box.bottom - event.clientY < BOTTOM_ZONE + (this.momentsOpen ? this.momentsRow.offsetHeight : 0)) zone = 'bottom';
    if (zone === this.zone) return;
    this.zone = zone;
    clearTimeout(this.restTimer);
    stage.classList.remove('near-right', 'near-bottom');
    if (zone) this.restTimer = setTimeout(() => stage.classList.add(`near-${zone}`), REST);
  }

  /** Shows the controls, and hides them later if the clip plays and the pointer is not on them. */
  wake() {
    if (!this.on) return;
    const { stage, player } = this.editor;
    stage.classList.add('awake');
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      const held = this.els.some((el) => el.matches(':hover'));
      if (player.playing && !held) {
        stage.classList.remove('awake', 'near-right', 'near-bottom');
        this.zone = '';
      } else this.wake();
    }, CONTROLS_DELAY);
  }
}
