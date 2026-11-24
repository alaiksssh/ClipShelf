// The row above the video that shows kills, deaths and marks.
import { h, icon } from './dom.js';
import { KINDS, colorOf, labelOf, placeMoments, placeRounds, roundOf } from '/shared/moments.mjs';
import * as format from './format.js';
import { VIDEO } from '/shared/pieces.mjs';
import { t } from './i18n.js';

const CHIP = 22; // Pixels, as a bare icon.
const SPACE = 3; // Between two chips.

export class MomentLane {
  constructor(timeline) {
    this.timeline = timeline;
    this.editor = timeline.editor;
    this.placed = [];
    this.chips = [];
    this.rounds = [];
    this.roundMarks = [];
    this.shown = '';
    this.lane = h('div', { class: 'lane moments-lane' });
    this.count = h('span', { class: 'count' });
    this.row = h('div', { class: 'row moments', hidden: true },
      h('div', { class: 'row-head caption' }, t('moments.title'), this.count),
      this.lane);
  }

  update() {
    const { editor } = this;
    const { moments, rounds } = editor.clip;
    const placed = placeMoments(moments, editor.edit.pieces);
    this.placed = placed;
    this.rounds = placeRounds(rounds, editor.edit.pieces);
    this.row.hidden = !moments.length && !this.rounds.length;
    this.count.textContent = String(placed.length);
    this.count.dataset.tip = placed.length === moments.length ? '' : t('moments.inClip', { count: moments.length });

    const shown = JSON.stringify([placed.map(({ id, moment, number }) => [id, moment.kind, moment.name, moment.color, number]),
      this.rounds.map((round) => round.number)]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.roundMarks = this.rounds.map(({ number }) => h('span', {
      class: 'round-mark',
      title: t('moments.roundStart', { n: number }),
    }, `R${number}`));
    this.chips = placed.map((item, index) => this.chip(item, index));
    this.lane.replaceChildren(...this.roundMarks, ...this.chips);
  }

  /** Read through the index, since a cut moves the moments without rebuilding their chips. */
  chip(item, index) {
    const { kind } = item.moment;
    const label = labelOf(item, t);
    return h('button', {
      class: `moment ${kind} ${item.moment.name ? 'named' : ''} ${label ? '' : 'unnamed'}`,
      style: { '--tint': `var(--${colorOf(item.moment)})` },
      title: kind === 'mark' ? t('moments.markClick') : `${label}\n${t('moments.clickGo')}\n${t('moments.dblName')}`,
      'aria-label': label || t(KINDS[kind].name),
      onPointerdown: (event) => event.stopPropagation(),
      onMousedown: (event) => event.preventDefault(), // The shortcuts keep working.
      onClick: (event) => {
        const placed = this.placed[index];
        this.editor.goToMoment(placed);
        if (kind === 'mark') this.editor.momentMenu(placed, { anchor: event.currentTarget, keyboard: event.detail === 0 });
      },
      onDblclick: () => this.editor.nameMoment(this.placed[index]),
      onContextmenu: (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.editor.momentMenu(this.placed[index], { x: event.clientX, y: event.clientY });
      },
      onPointerenter: (event) => {
        const placed = this.placed[index];
        const round = roundOf(placed.moment.time, this.editor.clip.rounds);
        this.timeline.showHint(event, labelOf(placed, t) || t(KINDS[kind].name),
          [round && t('moments.round', { n: round }), format.duration(placed.at, 1)].filter(Boolean).join(' · '));
      },
      onPointerleave: () => this.timeline.hideHint(),
    }, icon(KINDS[kind].icon), h('span', {}, label));
  }

  /**
   * Placed in pixels of the montage. A chip shows its name while there is room for it.
   * With `kept`, the pieces an edge being dragged leaves: what they no longer play fades.
   */
  place(scale, offset, kept = null) {
    if (this.row.hidden) return;
    const played = (time) => !kept || kept.some((piece) => piece.lane === VIDEO && time >= piece.from && time < piece.to);
    this.rounds.forEach(({ at }, index) => {
      this.roundMarks[index].style.left = `${at * scale + offset}px`;
    });
    const { selection } = this.editor;
    const selected = selection?.type === 'moment' ? selection.id : null;
    this.placed.forEach(({ id, at }, index) => {
      const chip = this.chips[index];
      if (!chip) return;
      const x = at * scale + offset;
      const next = this.placed[index + 1];
      const room = (next ? next.at * scale + offset : this.lane.clientWidth) - x - SPACE;
      chip.style.left = `${x}px`;
      chip.style.maxWidth = `${Math.max(CHIP, room)}px`;
      chip.classList.toggle('bare', room < CHIP * 2 || chip.classList.contains('unnamed'));
      chip.classList.toggle('active', id === selected);
      chip.classList.toggle('cut', !played(this.placed[index].moment.time));
    });
  }
}
