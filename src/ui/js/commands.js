// What the buttons, menus and shortcuts of the editor do to the montage.
import { toast } from './dom.js';
import * as P from '/shared/pieces.mjs';
import { zoneOf } from '/shared/edit.mjs';
import { removedParts, restorePart, restoreAll } from '/shared/restore.mjs';
import { transitionsOf, setTransition, edgeAt, edgesOf, SOUND_KIND } from '/shared/transitions.mjs';
import { t } from './i18n.js';

export class Commands {
  constructor(editor) {
    this.editor = editor;
    this.clipboard = null;
  }

  get pieces() {
    return this.editor.edit.pieces;
  }

  get time() {
    return this.editor.player.time;
  }

  selected() {
    const { selection } = this.editor;
    return selection?.type === 'pieces' ? this.pieces.filter((piece) => selection.ids.has(piece.id)) : [];
  }

  active() {
    const { selection } = this.editor;
    return selection?.type === 'pieces' ? this.pieces.find((piece) => piece.id === selection.active) : undefined;
  }

  /**
   * The span that moves as a whole column, when the selection calls for it:
   * magnet on and linked, contiguous picture selected.
   */
  rippleSpan() {
    const { magnet, selection } = this.editor;
    if (!magnet || !selection?.linked) return null;
    const picture = this.selected().filter((piece) => piece.lane === P.VIDEO).sort((a, b) => a.at - b.at);
    if (!picture.length) return null;
    const contiguous = picture.every((piece, i) => !i || Math.abs(piece.at - P.endOf(picture[i - 1])) < P.EPS);
    return contiguous ? P.spanOf(picture) : null;
  }

  split() {
    const { editor, time } = this;
    const selected = this.selected();
    const crossed = selected.filter((piece) => piece.at < time && P.endOf(piece) > time);
    // A track selected on its own stays the one being cut, wherever the playhead is.
    let target = crossed;
    if (!target.length && editor.selection?.linked === false) target = selected;
    const lanes = new Set(target.map((piece) => piece.lane));
    if (!lanes.size || lanes.has(P.VIDEO)) editor.apply(P.split(this.pieces, time));
    else if (lanes.size === 1) this.cutTrack([...lanes][0], time);
    else editor.apply(P.split(this.pieces, time, { only: (piece) => lanes.has(piece.lane), keepGroup: true }));
  }

  /** Cuts one lane and selects what follows the cut, alone. */
  cutTrack(lane, time = this.time) {
    const { editor } = this;
    const only = (piece) => piece.lane === lane;
    const pieces = P.split(this.pieces, time, { only, keepGroup: lane !== P.VIDEO });
    if (pieces === this.pieces) {
      toast(t('edit.nothingToCut'));
      return;
    }
    editor.apply(pieces);
    const piece = P.pieceAt(pieces, lane, time);
    if (piece) editor.selectPiece(piece, { linked: false });
  }

  cutPiece(piece, time, linked) {
    if (!linked) {
      this.cutTrack(piece.lane, time);
      return;
    }
    const ids = P.withLinked(this.pieces, new Set([piece.id]));
    this.editor.apply(P.split(this.pieces, time, { only: (p) => ids.has(p.id) }));
  }

  /** The zone starts or ends at the playhead. Nothing is removed: the rest stays in view. */
  zoneEdge(edge) {
    const { editor, time } = this;
    const length = P.totalLength(this.pieces);
    const [start, end] = zoneOf(editor.edit) || [0, length];
    let zone = edge === 'start' ? [time, end] : [start, time];
    // Past the other end: the zone starts afresh from there.
    if (zone[1] - zone[0] < P.MIN_LENGTH) zone = edge === 'start' ? [time, length] : [0, time];
    if (zone[1] - zone[0] < P.MIN_LENGTH) return;
    editor.change({ zone });
  }

  clearZone() {
    if (zoneOf(this.editor.edit)) this.editor.change({ zone: null });
  }

  deleteSpan(span) {
    this.commitRemoval(P.rippleDelete(this.pieces, span));
  }

  commitRemoval(pieces) {
    if (pieces === this.pieces) return;
    if (!pieces.some((piece) => piece.lane === P.VIDEO)) {
      toast(t('edit.keepOne'));
      return;
    }
    this.editor.selection = null;
    this.editor.apply(pieces);
    if (this.toldWhereItGoes || !this.removed().length) return;
    this.toldWhereItGoes = true; // Once per clip is enough.
    toast(t('edit.removed'));
  }

  removed() {
    return removedParts(this.pieces, this.editor.clip);
  }

  restore(part) {
    const { editor } = this;
    const { pieces, time } = restorePart(this.pieces, part);
    if (pieces === this.pieces) {
      toast(t('edit.placeTaken'));
      return;
    }
    editor.player.pause();
    editor.apply(pieces);
    editor.player.seek(time);
    const piece = P.pieceAt(pieces, part.lanes[0], time + P.EPS);
    if (piece) editor.selectPiece(piece);
  }

  restoreEverything() {
    this.editor.selection = null;
    this.editor.apply(restoreAll(this.pieces, this.editor.clip));
  }

  /**
   * Runs an action on the selected range. When that range also made the zone, the zone goes with it:
   * a passage selected to be muted or deleted is not what should be exported.
   */
  onRange(run) {
    const { editor } = this;
    const { selection } = editor;
    const zone = editor.edit.zone;
    editor.consumeZone = selection?.type === 'range' && Array.isArray(zone)
      && Math.abs(zone[0] - selection.range[0]) < 1e-6 && Math.abs(zone[1] - selection.range[1]) < 1e-6;
    try {
      run();
    } finally {
      editor.consumeZone = false;
    }
  }

  // Transitions

  /** The selected transition, as it plays now, or null. */
  selectedTransition() {
    const { selection } = this.editor;
    if (selection?.type !== 'transition') return null;
    return transitionsOf(this.pieces, selection.lane)
      .find((transition) => transition.owner.id === selection.id && transition.owner.side === selection.side) || null;
  }

  /** What the owner of a transition holds: its kind and the length it was given. */
  storedTransition(transition) {
    const owner = this.pieces.find((piece) => piece.id === transition.owner.id);
    return owner?.[transition.owner.side === 'in' ? 'transitionIn' : 'transitionOut'];
  }

  /** Selects the transition of a lane at a time, once the montage holds it. */
  selectTransitionAt(lane, time) {
    const found = transitionsOf(this.pieces, lane).find((transition) => Math.abs(transition.cut - time) < P.EPS);
    if (found) this.editor.select({ type: 'transition', lane, id: found.owner.id, side: found.owner.side });
  }

  /**
   * Puts the default transition at the cut or edge of a lane at `time`. On the picture, the tracks cut
   * at the same time get a crossfade too, as the sound of a cut goes with its picture.
   */
  addTransition(lane, time) {
    const { editor } = this;
    const duration = editor.transitionLength;
    let pieces = setTransition(this.pieces, lane, time, { kind: lane === P.VIDEO ? editor.transitionKind : SOUND_KIND, duration });
    if (lane === P.VIDEO) {
      editor.edit.tracks.forEach((_, track) => {
        if (edgeAt(pieces, track, time)) pieces = setTransition(pieces, track, time, { kind: SOUND_KIND, duration });
      });
    }
    if (pieces === this.pieces) {
      toast(t('transition.nothing'));
      return;
    }
    editor.apply(pieces);
    this.selectTransitionAt(lane, time);
  }

  /** The default transition at the cut of the picture nearest to the playhead. */
  transitionAtPlayhead() {
    const edges = edgesOf(this.pieces, P.VIDEO);
    if (!edges.length) return;
    const nearest = edges.reduce((best, edge) => (Math.abs(edge - this.time) < Math.abs(best - this.time) ? edge : best));
    this.addTransition(P.VIDEO, nearest);
  }

  removeTransition(transition = this.selectedTransition()) {
    if (!transition) return;
    this.editor.select(null);
    this.editor.apply(setTransition(this.pieces, transition.lane, transition.cut, null));
  }

  /** Another kind or length for the selected transition. The kind becomes the default one. */
  changeTransition(patch) {
    const { editor } = this;
    const transition = this.selectedTransition();
    if (!transition) return;
    const stored = this.storedTransition(transition);
    const value = { ...stored, ...patch };
    if (patch.kind) editor.setOption('transitionKind', patch.kind);
    if (patch.duration) editor.setOption('transitionLength', patch.duration);
    editor.apply(setTransition(this.pieces, transition.lane, transition.cut, value));
    this.selectTransitionAt(transition.lane, transition.cut);
  }

  remove() {
    const { editor } = this;
    const { selection } = editor;
    if (selection?.type === 'transition') {
      this.removeTransition();
      return;
    }
    if (selection?.type === 'moment') {
      const item = editor.moments.selected();
      if (item) editor.moments.remove(item);
      return;
    }
    if (selection?.type === 'range') {
      this.onRange(() => {
        if (selection.lane === P.VIDEO) this.deleteSpan(selection.range);
        else this.commitRemoval(P.clearRange(this.pieces, selection.lane, selection.range));
      });
      return;
    }
    const selected = this.selected();
    if (!selected.length) return;
    const picture = selected.filter((piece) => piece.lane === P.VIDEO);
    if (editor.magnet && selection.linked && picture.length) {
      // From the end, so that the earlier spans stay valid.
      const spans = picture.map((piece) => P.spanOf([piece])).sort((a, b) => b[0] - a[0]);
      this.commitRemoval(spans.reduce((pieces, span) => P.rippleDelete(pieces, span), this.pieces));
    } else {
      this.commitRemoval(this.pieces.filter((piece) => !selection.ids.has(piece.id)));
    }
  }

  keepRange() {
    const [start, end] = this.editor.selection.range;
    const after = P.rippleDelete(this.pieces, [end, P.totalLength(this.pieces)]);
    this.onRange(() => this.commitRemoval(P.rippleDelete(after, [0, start])));
    this.editor.player.seek(0);
  }

  isolateRange() {
    const { editor } = this;
    const { lane, range } = editor.selection;
    const options = lane === P.VIDEO ? {} : { only: (piece) => piece.lane === lane, keepGroup: true };
    const [start, end] = range;
    const pieces = P.split(P.split(this.pieces, start, options), end, options);
    this.onRange(() => editor.apply(pieces));
    editor.setTool('select');
    const piece = P.pieceAt(pieces, lane, (start + end) / 2);
    if (piece) editor.selectPiece(piece, { linked: lane === P.VIDEO });
  }

  muteRange(everyTrack = false) {
    const { editor } = this;
    const { lane, range } = editor.selection;
    const lanes = everyTrack || lane === P.VIDEO ? editor.edit.tracks.map((_, i) => i) : [lane];
    this.onRange(() => {
      editor.selection = null;
      editor.apply(P.muteRange(this.pieces, lanes, range));
    });
  }

  toggleMuted() {
    const piece = this.active();
    if (!piece) return;
    const { editor } = this;
    if (piece.lane !== P.VIDEO) {
      editor.apply(this.pieces.map((p) => (p.id === piece.id ? { ...p, muted: !p.muted } : p)));
      return;
    }
    // On the picture: all of its linked sound.
    const sound = (p) => p.group === piece.group && p.lane !== P.VIDEO;
    const muted = this.pieces.some((p) => sound(p) && !p.muted);
    editor.apply(this.pieces.map((p) => (sound(p) ? { ...p, muted } : p)));
  }

  /**
   * The pieces of sound that the volume of the toolbar sets. A piece picked with its linked ones is
   * set alone: the volume of one piece of one track. Pieces picked on their own are set together.
   */
  volumeTargets() {
    const piece = this.active();
    if (!piece || piece.lane === P.VIDEO) return [];
    if (this.editor.selection.linked) return [piece];
    return this.selected().filter((p) => p.lane !== P.VIDEO);
  }

  pieceVolume(volume, pieces = this.pieces) {
    const ids = new Set(this.volumeTargets().map((piece) => piece.id));
    this.editor.apply(P.setVolume(pieces, ids, volume));
  }

  /** The lanes that the volume of a selected range sets: every track when it was drawn on the picture. */
  rangeLanes() {
    const { lane } = this.editor.selection;
    return lane === P.VIDEO ? this.editor.edit.tracks.map((_, i) => i) : [lane];
  }

  rangeVolume(volume, pieces = this.pieces) {
    const { range } = this.editor.selection;
    this.onRange(() => this.editor.apply(P.volumeRange(pieces, this.rangeLanes(), range, volume)));
  }

  mute() {
    if (this.editor.selection?.type === 'range') this.muteRange();
    else this.toggleMuted();
  }

  speed(value) {
    const { editor } = this;
    const piece = this.active();
    if (!piece) return;
    const { linked } = editor.selection;
    const ripple = editor.magnet && linked && (piece.lane === P.VIDEO
      || this.selected().some((p) => p.lane === P.VIDEO && Math.abs(p.at - piece.at) < P.EPS && Math.abs(P.endOf(p) - P.endOf(piece)) < P.EPS));
    const pieces = P.setSpeed(this.pieces, piece.id, value, { linked, ripple });
    if (pieces !== this.pieces) editor.apply(pieces);
    else if (Math.abs(piece.speed - value) > P.EPS) {
      toast(t('edit.noRoomSpeed'));
      editor.update();
    }
  }

  unlink() {
    const piece = this.active();
    if (!piece) return;
    const group = Math.max(...this.pieces.map((p) => p.group)) + 1;
    const pieces = this.pieces.map((p) => (p.id === piece.id ? { ...p, group } : p));
    this.editor.apply(pieces);
    this.editor.selectPiece({ ...piece, group }, { linked: false });
  }

  copy() {
    const { selection } = this.editor;
    const selected = this.selected();
    const span = selection?.type === 'range' ? selection.range : this.rippleSpan();
    if (span) {
      this.clipboard = { ripple: true, length: span[1] - span[0], items: P.copySpan(this.pieces, span) };
    } else if (selected.length) {
      const [start, end] = P.spanOf(selected);
      this.clipboard = { ripple: false, length: end - start, items: selected.map((p) => ({ ...p, at: p.at - start })) };
    } else {
      return;
    }
    toast(t('edit.copied'));
  }

  paste(time = this.time, clip = this.clipboard) {
    if (!clip) return;
    const { editor } = this;
    const { pieces, ids } = clip.ripple
      ? P.insert(this.pieces, clip.items, time, clip.length)
      : P.place(this.pieces, clip.items, time);
    if (!ids.length) return;
    editor.apply(pieces);
    const added = pieces.filter((piece) => ids.includes(piece.id)).sort((a, b) => a.lane - b.lane);
    editor.select({ type: 'pieces', ids: new Set(ids), active: added[0].id, linked: clip.ripple });
  }

  duplicate() {
    const selected = this.selected();
    if (!selected.length) return;
    const span = this.rippleSpan();
    const [start, end] = span || P.spanOf(selected);
    this.paste(end, {
      ripple: Boolean(span),
      length: end - start,
      items: span ? P.copySpan(this.pieces, span) : selected.map((piece) => ({ ...piece, at: piece.at - start })),
    });
  }

  selectAll() {
    const { pieces } = this;
    const first = P.onLane(pieces, P.VIDEO)[0];
    this.editor.select({ type: 'pieces', ids: new Set(pieces.map((p) => p.id)), active: first.id, linked: true });
  }

  /** The hole around `time`, when no lane has anything there. */
  gapAt(time) {
    let start = 0;
    let end = Infinity;
    for (const piece of this.pieces) {
      const pieceEnd = P.endOf(piece);
      if (piece.at <= time && pieceEnd > time) return null;
      if (pieceEnd <= time) start = Math.max(start, pieceEnd);
      else end = Math.min(end, piece.at);
    }
    return Number.isFinite(end) && end - start > P.EPS ? [start, end] : null;
  }

  jumpToCut(direction) {
    const { time, editor } = this;
    const cuts = this.pieces.flatMap((piece) => [piece.at, P.endOf(piece)]).sort((a, b) => a - b);
    const target = direction > 0
      ? cuts.find((cut) => cut > time + 0.01)
      : cuts.filter((cut) => cut < time - 0.01).at(-1);
    if (target === undefined) return;
    editor.player.pause();
    editor.player.seek(target);
  }
}
