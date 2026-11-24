// What can be done with the moments of the clip that is being edited.
import { call, toast } from './dom.js';
import { showMenu } from './menu.js';
import { askText } from './dialogs.js';
import * as format from './format.js';
import { VIDEO, pieceAt, sourceAt, EPS } from '/shared/pieces.mjs';
import { KINDS, NAME_LENGTH, MARK_COLORS, colorOf, labelOf, placeMoments, roundOf } from '/shared/moments.mjs';
import { t } from './i18n.js';

const SUGGESTIONS = ['Ace', 'Clutch', 'Flick', 'One tap', 'Wallbang', 'Fail'];

export class Moments {
  constructor(editor) {
    this.editor = editor;
  }

  placed() {
    const { clip, edit } = this.editor;
    return placeMoments(clip.moments, edit.pieces);
  }

  selected() {
    const { selection } = this.editor;
    if (selection?.type !== 'moment') return null;
    const found = this.placed().filter((item) => item.id === selection.id);
    // A duplicated part shows it twice: the one under the playhead.
    const { time } = this.editor.player;
    return found.sort((a, b) => Math.abs(a.at - time) - Math.abs(b.at - time))[0] ?? null;
  }

  go(item) {
    const { editor } = this;
    editor.player.seek(item.at);
    editor.select({ type: 'moment', id: item.id });
    editor.timeline.reveal(item.at);
  }

  jump(direction) {
    const { time } = this.editor.player;
    const placed = this.placed();
    const next = direction > 0
      ? placed.find((item) => item.at > time + 0.05)
      : placed.filter((item) => item.at < time - 0.3).at(-1); // While playing, back means the one before.
    if (next) this.go(next);
  }

  async mark() {
    const { editor } = this;
    const { clip, edit, player } = editor;
    const time = Math.max(0, Math.min(player.time, player.length - EPS * 2));
    const piece = pieceAt(edit.pieces, VIDEO, time);
    if (!piece) {
      toast(t('moments.markOnVideo'));
      return;
    }
    const at = Math.min(clip.duration, sourceAt(piece, time));
    const { ok, value } = await call('moments', clip.id, { add: { time: at } });
    if (ok && editor.clip?.id === clip.id) editor.select({ type: 'moment', id: value });
  }

  async name(item) {
    const { clip } = this.editor;
    const value = await askText({
      title: t('moments.nameTitle'),
      text: t('moments.at', { kind: t(KINDS[item.moment.kind].name), time: format.duration(item.at, 1) }),
      symbol: 'title',
      value: item.moment.name,
      suggestions: [...new Set([...SUGGESTIONS, ...clip.moments.map((moment) => moment.name).filter(Boolean)])],
      maxLength: NAME_LENGTH,
    });
    if (value !== null) await call('moments', clip.id, { name: { id: item.id, value } });
  }

  async remove(item) {
    const { editor } = this;
    editor.select(null);
    if (!(await call('moments', editor.clip.id, { remove: item.id })).ok) return;
    toast(item.moment.kind === 'mark'
      ? t('moments.markRemoved')
      : t('moments.removed'));
  }

  async detectAgain() {
    if ((await call('moments', this.editor.clip.id, { redetect: true })).ok) toast(t('moments.redetecting'));
  }

  menu(item, place) {
    const mark = item.moment.kind === 'mark';
    const current = colorOf(item.moment);
    showMenu({
      ...place,
      title: `${labelOf(item, t) || t(KINDS[item.moment.kind].name)}, ${format.duration(item.at, 1)}`,
      items: [
        !mark && { icon: 'play', label: t('moments.go'), run: () => this.go(item) },
        { icon: 'title', label: item.moment.name ? t('common.rename') : t('lib.name'), run: () => this.name(item) },
        mark && '-',
        ...(mark ? MARK_COLORS : []).map((color) => ({
          icon: 'flag',
          tint: color,
          label: t(`color.${color}`),
          checked: color === current,
          run: () => this.setColor(item, color),
        })),
        '-',
        { icon: 'trash', label: t('common.remove'), danger: true, run: () => this.remove(item) },
      ],
    });
  }

  async setColor(item, color) {
    await call('moments', this.editor.clip.id, { color: { id: item.id, value: color } });
  }

  list(place) {
    const { editor } = this;
    const { clip } = editor;
    const placed = this.placed();
    const valorant = clip.game.toLowerCase() === 'valorant';
    let title = t('moments.title');
    if (valorant && !clip.detected) title = editor.app.state.detection?.on ? t('moments.analysing') : t('moments.detectionOff');
    else if (clip.replay) title = t('moments.replay');

    showMenu({
      ...place,
      title,
      items: [
        ...placed.map((item) => ({
          icon: KINDS[item.moment.kind].icon,
          tint: colorOf(item.moment),
          label: labelOf(item, t) || t(KINDS[item.moment.kind].name),
          detail: [roundOf(item.moment.time, clip.rounds) && t('moments.round', { n: roundOf(item.moment.time, clip.rounds) }),
            format.duration(item.at, 1)].filter(Boolean).join(' · '),
          run: () => this.go(item),
        })),
        '-',
        { icon: 'flag', tint: 'warn', label: t('editor.markHere'), hint: 'B', run: () => this.mark() },
        valorant && clip.detected && { icon: 'refresh', label: t('moments.detectAgain'), run: () => this.detectAgain() },
      ],
    });
  }
}
