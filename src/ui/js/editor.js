import { h, icon, button, call, toast, remember, store } from './dom.js';
import { showMenu, closeMenu } from './menu.js';
import * as format from './format.js';
import * as P from '/shared/pieces.mjs';
import { createEdit, loadEdit, defaultTracks, zoneOf, outputEdit } from '/shared/edit.mjs';
import { cropRect, clamp } from '/shared/geometry.mjs';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { TRACK_COLORS } from './painter.js';
import { Toolbar } from './toolbar.js';
import { Commands } from './commands.js';
import { STYLES } from './waveforms.js';
import { openExport, openOverwrite, openDiscord } from './export.js';
import { Moments } from './moments.js';
import { NAME_LENGTH } from '/shared/moments.mjs';
import { VIDEO_KINDS, DURATIONS, DEFAULT_DURATION, transitionsOf } from '/shared/transitions.mjs';
import { categoryColor, pickCategory } from './categories.js';
import { t } from './i18n.js';
import { VideoAlone } from './videoAlone.js';

const HISTORY = 200;
// Heights the bar above the tools can give the timeline, in pixels. Below the lowest one only the
// ruler would show; the video always keeps the other one.
const TIMELINE_MIN = 60;
const STAGE_MIN = 140;
// The keys the video alone answers to: playback, marks and details only, since the montage is out
// of sight.
const VIDEO_KEYS = new Set([' ', 'arrowleft', 'arrowright', 'home', 'end', 'b', 'escape']);
const VIDEO_CTRL_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'i']);

const sameEdit = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SAVE_DELAY = 500;
const SKIP = 5; // Seconds.

export class Editor {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.clip = null;
    this.magnet = remember('magnet', true);
    this.linked = remember('linked', true);
    this.audioStyle = remember('audioStyle', 'wave');
    if (!STYLES[this.audioStyle]) this.audioStyle = 'wave';
    // The transition that Ctrl+T and the menus put: the last kind and length chosen.
    this.transitionKind = remember('transitionKind', 'dissolve');
    if (!Object.hasOwn(VIDEO_KINDS, this.transitionKind)) this.transitionKind = 'dissolve';
    this.transitionLength = remember('transitionLength', DEFAULT_DURATION);
    if (!DURATIONS.includes(this.transitionLength)) this.transitionLength = DEFAULT_DURATION;
    // Null while the timeline keeps its own height.
    this.timelineHeight = remember('timelineHeight', null);
    this.videoOnly = false;
    app.subscribe(() => this.refresh());
  }

  open(clip, order = [], { play = false } = {}) {
    this.teardown();
    this.clip = clip;
    this.order = order;
    this.analysis = null;
    this.selection = null;
    this.tool = 'select';
    this.modified = Boolean(clip.edit);
    this.dirty = false;
    this.edit = loadEdit(clip.edit, clip);
    this.history = [this.edit];
    this.cursor = 0;

    this.commands = new Commands(this);
    this.moments = new Moments(this);
    this.seenMoments = null;
    this.player = new Player({
      clip,
      getEdit: () => this.edit,
      getZone: () => (this.selection?.type === 'range' ? this.selection.range : zoneOf(this.edit)),
      onFrame: (time) => this.frame(time),
      onPlayState: (playing) => this.showPlaying(playing),
      onError: (retry) => this.fallback(retry),
      onTrackError: (index) => toast(t('editor.trackError', { n: index + 1 }), 'error'),
    });
    this.player.setVolume(remember('volume', 1));
    this.timeline = new Timeline(this);
    this.toolbar = new Toolbar(this);
    this.alone = new VideoAlone(this);
    this.build();
    this.root.hidden = false;
    this.timeline.resize();
    this.update();
    this.analyse(clip);
    call('watching', clip.id);
    if (play) this.player.play();
  }

  async analyse(clip) {
    const { player } = this;
    const { ok, value } = await call('analysis', clip.id);
    if (this.player !== player) return; // Another clip was opened meanwhile.
    if (!ok) {
      this.timeline.fail(t('editor.analysisFailed'));
      return;
    }
    this.analysis = value;
    if (!this.modified) {
      const defaults = defaultTracks(clip.audio.length, value);
      this.edit = { ...this.edit, tracks: this.edit.tracks.map((track, i) => ({ ...track, on: defaults[i].on })) };
      this.history = [this.edit];
      this.cursor = 0;
    }
    this.timeline.setAnalysis(value);
    this.update();
  }

  build() {
    const { actions } = this.app;
    const at = this.order.indexOf(this.clip.id);

    this.saveButton = button({
      icon: 'save',
      label: t('overwrite.go'),
      class: 'overwrite',
      onClick: () => this.overwrite(),
    });
    this.title = h('h1');
    this.titleField = h('button', {
      class: 'clip-title',
      onClick: () => this.editTitle(),
    }, this.title, icon('pencil'));
    this.titleInput = h('input', {
      class: 'field title-input',
      hidden: true,
      spellcheck: 'false',
      maxlength: NAME_LENGTH,
      'aria-label': t('editor.clipName'),
      onBlur: () => this.saveTitle(),
      onKeydown: (event) => {
        if (event.key === 'Escape') this.titleInput.value = this.titleBefore;
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        this.titleInput.blur();
      },
    });
    this.categoryButton = h('button', {
      class: 'chip',
      'aria-haspopup': 'menu',
      onClick: (event) => pickCategory(this.app, [this.clip], { anchor: event.currentTarget, keyboard: event.detail === 0 }),
    });
    this.tagsButton = h('button', { class: 'chip', onClick: () => actions.tag([this.clip]) });
    this.info = h('span', { class: 'info' });
    this.heart = button({ icon: 'heart', title: t('lib.favorite'), class: 'ghost', onClick: () => actions.favorite([this.clip]) });
    const bar = h('header', { class: 'editor-bar drag-region' },
      button({ icon: 'back', label: 'Clips', title: t('editor.back'), class: 'ghost', onClick: () => this.app.closeClip() }),
      this.titleField,
      this.titleInput,
      this.categoryButton,
      this.tagsButton,
      this.info,
      h('div', { class: 'spacer' }),
      button({ icon: 'back', title: t('editor.previous'), class: 'ghost', disabled: at <= 0, onClick: () => this.step(-1) }),
      button({ icon: 'next', title: t('editor.next'), class: 'ghost', disabled: at < 0 || at >= this.order.length - 1, onClick: () => this.step(1) }),
      this.heart,
      button({ icon: 'more', title: t('editor.clipActions'), class: 'ghost', onClick: (event) => this.clipMenu(event) }),
      this.saveButton,
      button({
        icon: 'discord',
        label: 'Discord',
        title: t('editor.discordTitle'),
        class: 'discord',
        onClick: () => this.discord(),
      }),
      button({ icon: 'output', label: t('export.title'), title: t('editor.exportTitle'), class: 'primary', onClick: () => this.export() }));

    this.crop = h('div', { class: 'crop', hidden: true, onPointerdown: (event) => this.dragCrop(event) });
    this.message = h('div', { class: 'stage-message', hidden: true });
    this.stage = h('div', {
      class: 'stage',
      onClick: (event) => {
        if (event.target !== this.crop) this.player.toggle();
      },
      // Two clicks also toggle playing twice, which leaves it as it was, as in video players.
      onDblclick: (event) => {
        if (event.target !== this.crop) this.setVideoOnly(!this.videoOnly);
      },
      onPointermove: (event) => this.alone.point(event),
    }, this.player.videos, this.player.veil, this.crop, this.message, ...this.alone.els);

    this.split = h('div', {
      class: 'split',
      role: 'separator',
      'aria-orientation': 'horizontal',
      title: t('editor.splitTip'),
      onPointerdown: (event) => this.dragSplit(event),
      onDblclick: () => {
        this.setTimelineHeight(null);
        store('timelineHeight', null);
      },
    });
    this.root.replaceChildren(bar, this.stage, this.split, h('section', { class: 'panel' }, this.toolbar.el, this.timeline.el));
    // Not measured here, where the editor may still be hidden: the style keeps it on smaller windows.
    if (this.timelineHeight) this.root.style.setProperty('--timeline-height', `${this.timelineHeight}px`);
    this.stageObserver = new ResizeObserver(() => this.placeCrop());
    this.stageObserver.observe(this.stage);
    this.refresh();
  }

  /** The clip may have changed on disk or in the library. */
  refresh() {
    // While the file is being replaced, the library already describes the next one.
    if (!this.clip || this.replacing) return;
    this.clip = this.app.clip(this.clip.id) || this.clip;
    const { clip } = this;
    this.title.textContent = format.title(clip);
    this.titleField.dataset.tip = `${t('editor.nameHint')}\n${clip.path}`;

    const { categories = [] } = this.app.state;
    this.categoryButton.style.setProperty('--tint',
      clip.category ? `var(--${categoryColor(categories, clip.category)})` : 'var(--dim)');
    this.categoryButton.classList.toggle('set', Boolean(clip.category));
    this.categoryButton.replaceChildren(icon('category'), h('span', {}, clip.category || t('categories.title')));
    this.categoryButton.dataset.tip = clip.category ? t('editor.categoryOf', { name: clip.category }) : t('editor.fileIn');
    this.tagsButton.classList.toggle('set', clip.tags.length > 0);
    this.tagsButton.style.setProperty('--tint', clip.tags.length ? 'var(--accent)' : 'var(--dim)');
    this.tagsButton.replaceChildren(icon('tag'), h('span', {}, clip.tags.join(', ') || t('lib.tags')));
    this.tagsButton.dataset.tip = clip.tags.length ? t('editor.tagsOf', { tags: clip.tags.join(', ') }) : t('editor.addTags');

    this.info.textContent = [
      `${clip.width}×${clip.height}`,
      t('editor.fps', { n: Math.round(clip.fps) }),
      format.bytes(clip.size),
    ].join(' · ');
    this.heart.classList.toggle('loved', clip.favorite);
    this.heart.replaceChildren(icon(clip.favorite ? 'heartOn' : 'heart'));

    const moments = JSON.stringify([clip.moments, clip.detected]);
    if (this.seenMoments !== null && moments !== this.seenMoments) {
      if (this.selection?.type === 'moment' && !clip.moments.some((m) => m.id === this.selection.id)) this.selection = null;
      this.timeline.update();
      this.toolbar.update();
    }
    this.seenMoments = moments;
    this.alone.paint();
  }

  editTitle() {
    const { titleInput, titleField, clip } = this;
    this.titleBefore = format.title(clip);
    titleInput.value = this.titleBefore;
    titleField.hidden = true;
    titleInput.hidden = false;
    titleInput.focus();
    titleInput.select();
  }

  saveTitle() {
    const { titleInput, titleField } = this;
    if (titleInput.hidden) return;
    const value = titleInput.value.trim();
    titleInput.hidden = true;
    titleField.hidden = false;
    if (value !== this.titleBefore) this.app.actions.setTitle(this.clip, value);
  }

  // Moments

  goToMoment(item) {
    this.moments.go(item);
  }

  nameMoment(item) {
    return this.moments.name(item);
  }

  momentMenu(item, place) {
    this.moments.menu(item, place);
  }

  skip(seconds) {
    this.player.seek(this.player.time + seconds);
    this.timeline.reveal(this.player.time);
  }

  // Edit state and history

  /** Shows a list of pieces without recording it, during a gesture. */
  preview(pieces) {
    this.show({ ...this.edit, pieces });
  }

  /**
   * Shows and plays an edit without recording it. The toolbar is left as it is, so that a control
   * being dragged there stays under the pointer.
   */
  show(edit) {
    this.edit = edit;
    this.timeline.layout();
    this.timeline.draw();
    this.showTime();
  }

  restore(edit) {
    this.edit = edit;
    this.update();
  }

  apply(pieces) {
    if (pieces === this.edit.pieces) {
      this.update();
      return;
    }
    this.change({ pieces });
  }

  change(patch, { live = false } = {}) {
    // A range that was used for an action is no longer the zone it made.
    if (this.consumeZone && 'pieces' in patch) patch = { ...patch, zone: null };
    this.edit = { ...this.edit, ...patch };
    if (live) this.update();
    else this.commit();
  }

  /** Heard and shown at once, but returning to the recorded value gives back the same edit. */
  previewVolume(index, volume) {
    const recorded = this.history[this.cursor];
    if (recorded.tracks[index].volume === volume) this.edit = recorded;
    else this.edit = { ...this.edit, tracks: this.edit.tracks.with(index, { ...this.edit.tracks[index], volume }) };
    this.update();
  }

  changeTrack(index, patch, options) {
    const tracks = this.edit.tracks.with(index, { ...this.edit.tracks[index], ...patch });
    this.change({ tracks }, options);
  }

  commit() {
    const recorded = this.history[this.cursor];
    // A gesture or a control that ends where it started gives back the same edit: no empty step.
    if (this.edit !== recorded && sameEdit(this.edit, recorded)) this.edit = recorded;
    if (this.edit !== recorded) {
      this.history = [...this.history.slice(0, this.cursor + 1), this.edit].slice(-HISTORY);
      this.cursor = this.history.length - 1;
      this.modified = true;
      this.save();
    }
    this.dropStaleSelection(recorded.pieces);
    const { length } = this.player;
    if (this.player.time > length) this.player.seek(length);
    this.update();
  }

  canTravel(direction) {
    return Boolean(this.history[this.cursor + direction]);
  }

  travel(direction) {
    if (!this.canTravel(direction)) return;
    this.timeline.cancel();
    this.cursor += direction;
    this.edit = this.history[this.cursor];
    this.selection = null;
    this.modified = true;
    this.save();
    this.player.seek(this.player.time);
    this.update();
  }

  reset() {
    this.selection = null;
    this.edit = createEdit(this.clip, this.analysis);
    this.commit();
    this.modified = false; // Back to the original: no "edited" badge.
    this.updateSaveButton();
    this.timeline.fit();
  }

  save() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.clip) return;
    this.dirty = false;
    call('update', [this.clip.id], { edit: this.modified ? this.edit : null });
  }

  // Selection and modes

  select(selection) {
    this.selection = selection;
    this.timeline.draw();
    this.toolbar.renderContext();
  }

  /** Whether acting on this piece takes its linked pieces along. Alt inverts the Link option. */
  linkedFor(piece, invert = false) {
    if (invert) return !this.linked;
    return this.linked && !P.standsAlone(this.edit.pieces, piece);
  }

  /** Whether pointing at a piece keeps the selection it is already part of. */
  keepsSelection(piece) {
    const { selection } = this;
    if (selection?.type !== 'pieces' || !selection.ids.has(piece.id)) return false;
    return !selection.linked || !P.standsAlone(this.edit.pieces, piece);
  }

  selectPiece(piece, { linked = this.linkedFor(piece), add = false } = {}) {
    const { pieces } = this.edit;
    const own = linked ? P.withLinked(pieces, new Set([piece.id])) : new Set([piece.id]);
    let ids = own;
    if (add && this.selection?.type === 'pieces') {
      ids = new Set(this.selection.ids);
      const remove = ids.has(piece.id);
      for (const id of own) {
        if (remove) ids.delete(id);
        else ids.add(id);
      }
    }
    if (!ids.size) {
      this.select(null);
      return;
    }
    const active = ids.has(piece.id) ? piece.id : [...ids][0];
    this.select({ type: 'pieces', ids, active, linked: linked || Boolean(add && this.selection?.linked) });
  }

  /**
   * Forgets the selected pieces that are gone. A linked selection also lets go of the pieces that the
   * edit moved to another group: sound cut further right goes with the right half of a cut picture,
   * and the next action would otherwise reach it without its picture.
   */
  dropStaleSelection(before = []) {
    const { selection } = this;
    if (selection?.type !== 'pieces') return;
    const kept = this.edit.pieces.filter((p) => selection.ids.has(p.id));
    const active = kept.find((p) => p.id === selection.active);
    if (!active) {
      this.selection = null;
      return;
    }
    let stays = kept;
    if (selection.linked) {
      const groupBefore = new Map(before.map((p) => [p.id, p.group]));
      const regrouped = (p) => groupBefore.has(p.id) && groupBefore.get(p.id) !== p.group;
      stays = kept.filter((p) => p.group === active.group || !regrouped(p));
    }
    this.selection = { ...selection, ids: new Set(stays.map((p) => p.id)) };
  }

  setTool(tool) {
    this.tool = tool;
    this.selection = null;
    this.update();
  }

  setOption(name, value) {
    this[name] = value;
    store(name, value);
    if (name === 'linked') this.selection = null;
    this.update();
  }

  trackName(index) {
    return this.edit.tracks[index].name || this.analysis?.tracks[index]?.label || t('track.n', { n: index + 1 });
  }

  // Display

  update() {
    this.timeline.update();
    this.toolbar.update();
    this.updateSaveButton();
    this.placeCrop();
    this.showTime();
    this.alone.paintMoments();
  }

  updateSaveButton() {
    this.saveButton.disabled = !this.modified;
    this.saveButton.dataset.tip = this.modified
      ? t('editor.overwriteTitle')
      : t('editor.unchanged');
  }

  showTime() {
    const { time, length } = this.player;
    this.toolbar.showTime(time, length);
    this.alone?.showTime();
  }

  showPlaying(playing) {
    this.toolbar?.showPlaying(playing);
    this.alone?.showPlaying(playing);
  }

  // Size of the video

  /** The bar between the video and the tools gives the timeline a height, and the video the rest. */
  dragSplit(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const { split } = this;
    const from = event.clientY;
    const start = this.timeline.el.getBoundingClientRect().height;
    split.setPointerCapture(event.pointerId);
    split.classList.add('dragging');
    const move = (next) => this.setTimelineHeight(start + from - next.clientY);
    // Losing the capture also ends it, so a release that another window took cannot leave it held.
    const end = () => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('lostpointercapture', end);
      split.classList.remove('dragging');
      store('timelineHeight', this.timelineHeight);
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('lostpointercapture', end);
  }

  /** A height in pixels, kept within what leaves the video its least height; null for the default. */
  setTimelineHeight(height) {
    if (height === null || !Number.isFinite(height)) {
      this.timelineHeight = null;
      this.root.style.removeProperty('--timeline-height');
      return;
    }
    const tools = this.toolbar.el.getBoundingClientRect().height;
    const most = Math.max(TIMELINE_MIN, this.root.clientHeight - this.stage.offsetTop - STAGE_MIN - tools - 30);
    this.timelineHeight = Math.round(clamp(height, TIMELINE_MIN, most));
    this.root.style.setProperty('--timeline-height', `${this.timelineHeight}px`);
  }

  /** The video alone over the whole screen (videoAlone.js). Only clips go full screen, never the app. */
  setVideoOnly(on) {
    if (on === this.videoOnly) return;
    this.videoOnly = on;
    closeMenu();
    this.root.classList.toggle('video-only', on);
    document.body.classList.toggle('video-only', on);
    window.bridge.fullScreen(on);
    if (!on) {
      this.alone.leave();
      return;
    }
    if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.alone.enter();
  }

  frame(time) {
    if (time === this.lastTime || !this.toolbar) return;
    this.lastTime = time;
    this.timeline.setTime(time, this.player.playing);
    this.showTime();
  }

  placeCrop() {
    const { width, height } = this.clip;
    const rect = cropRect(width, height, this.edit.ratio, this.edit.position);
    this.crop.hidden = !rect;
    if (!rect) return;
    const { clientWidth, clientHeight } = this.stage;
    const scale = Math.min(clientWidth / width, clientHeight / height);
    Object.assign(this.crop.style, {
      left: `${(clientWidth - width * scale) / 2 + rect.x * scale}px`,
      top: `${(clientHeight - height * scale) / 2 + rect.y * scale}px`,
      width: `${rect.w * scale}px`,
      height: `${rect.h * scale}px`,
    });
  }

  dragCrop(event) {
    if (event.button !== 0) return;
    const { clip, crop, stage } = this;
    const rect = cropRect(clip.width, clip.height, this.edit.ratio);
    const scale = Math.min(stage.clientWidth / clip.width, stage.clientHeight / clip.height);
    // Only one axis has room to move.
    const horizontal = clip.width - rect.w > clip.height - rect.h;
    const room = (horizontal ? clip.width - rect.w : clip.height - rect.h) * scale;
    if (room <= 0) return;
    const point = (e) => (horizontal ? e.clientX : e.clientY);
    const start = point(event);
    const from = this.edit.position;

    crop.setPointerCapture(event.pointerId);
    crop.onpointermove = (e) => {
      this.edit = { ...this.edit, position: clamp(from + (point(e) - start) / room, 0, 1) };
      this.placeCrop();
    };
    crop.onpointerup = () => {
      crop.onpointermove = null;
      crop.onpointerup = null;
      this.commit();
    };
  }

  async fallback(retry) {
    const { player, message } = this;
    message.hidden = false;
    if (this.triedProxy === player) {
      message.textContent = t('editor.unreadable');
      return;
    }
    this.triedProxy = player;
    message.textContent = t('editor.makingProxy');
    const { ok, error } = await call('proxy', this.clip.id);
    if (this.player !== player) return;
    if (!ok) {
      message.textContent = error;
      return;
    }
    player.useProxy();
    retry();
    message.hidden = true;
  }

  // Menus and clip actions

  timelineMenu(event, time, piece) {
    const { commands, selection } = this;
    let items;
    let title;
    if (piece) {
      if (this.keepsSelection(piece)) this.select({ ...selection, active: piece.id });
      else this.selectPiece(piece);
      const sound = piece.lane !== P.VIDEO;
      title = `${sound ? this.trackName(piece.lane) : t('editor.video')}, ${format.duration(P.lengthOf(piece), 1)}`;
      items = [
        { icon: 'scissors', label: t('editor.cutHere'), run: () => commands.cutPiece(piece, time, this.linked) },
        sound && {
          icon: 'razor',
          label: t('editor.cutTrack'),
          run: () => commands.cutPiece(piece, time, false),
        },
        '-',
        { icon: 'duplicate', label: t('editor.duplicate'), hint: 'Ctrl+D', run: () => commands.duplicate() },
        { icon: 'copy', label: t('editor.copy'), hint: 'Ctrl+C', run: () => commands.copy() },
        commands.clipboard && { icon: 'paste', label: t('editor.pasteHere'), hint: 'Ctrl+V', run: () => commands.paste(time) },
        '-',
        {
          icon: piece.muted ? 'volume' : 'muted',
          label: piece.muted ? t('editor.unmute') : t('editor.mute'),
          hint: 'M',
          run: () => commands.toggleMuted(),
        },
        sound && { icon: 'link', label: t('editor.unlink'), run: () => commands.unlink() },
        '-',
        ...this.transitionItems(piece),
        sound && Math.abs(P.volumeOf(piece) - 1) > P.EPS && {
          icon: 'volume',
          label: t('piece.volumeReset'),
          run: () => commands.pieceVolume(1),
        },
      ];
    } else {
      const gap = commands.gapAt(time);
      items = [
        gap && { icon: 'gap', label: t('editor.closeGap'), run: () => commands.deleteSpan(gap) },
        commands.clipboard && { icon: 'paste', label: t('editor.pasteHere'), hint: 'Ctrl+V', run: () => commands.paste(time) },
      ];
    }
    const point = { x: event.clientX, y: event.clientY };
    if (commands.removed().length) {
      items.push('-', {
        icon: 'history',
        tint: 'accent',
        label: t('editor.restorePart'),
        run: () => this.removedMenu(point),
      });
    }
    if (piece?.lane === P.VIDEO) {
      items.push('-', {
        icon: 'flag',
        tint: 'warn',
        label: t('editor.markHere'),
        run: () => {
          this.player.seek(time);
          this.moments.mark();
        },
      }, {
        icon: 'image',
        label: t('editor.useAsThumb'),
        run: () => this.setThumb(Math.min(this.clip.duration, P.sourceAt(piece, time))),
      });
    }
    if (this.clip.thumb !== null) {
      items.push(piece?.lane !== P.VIDEO && '-', { icon: 'reset', label: t('editor.defaultThumb'), run: () => this.setThumb(null) });
    }
    if (piece) {
      items.push('-', { icon: 'trash', label: t('common.delete'), hint: t('key.delete'), danger: true, run: () => commands.remove() });
    }
    showMenu({ ...point, title, items });
  }

  /** Add or remove the transition at the start and at the end of a piece. */
  transitionItems(piece) {
    const { commands } = this;
    const list = transitionsOf(this.edit.pieces, piece.lane);
    return [['start', piece.at], ['end', P.endOf(piece)]].map(([side, time]) => {
      const found = list.find((transition) => Math.abs(transition.cut - time) < P.EPS);
      return found
        ? { icon: 'transition', label: t(`transition.remove.${side}`), run: () => commands.removeTransition(found) }
        : { icon: 'transition', label: t(`transition.add.${side}`), run: () => commands.addTransition(piece.lane, time) };
    });
  }

  /** The card shows the picture at `time` of the file, or the one chosen by the app with null. */
  async setThumb(time) {
    const { ok } = await call('update', [this.clip.id], { thumb: time });
    if (ok) toast(time === null ? t('editor.thumbReset') : t('editor.thumbSet'));
  }

  removedMenu(place) {
    const { clip, commands } = this;
    const parts = commands.removed();
    const items = parts.map((part) => {
      const picture = part.lanes.includes(P.VIDEO);
      const frame = Math.min(clip.filmFrames - 1, Math.floor(((part.from + part.to) / 2 / clip.duration) * clip.filmFrames));
      let what;
      if (picture) what = part.lanes.length > 1 ? t('editor.videoAndSound') : t('editor.videoOnly');
      else what = part.lanes.map((lane) => this.trackName(lane)).join(', ');
      return {
        image: picture ? `/strip/${clip.id}/${frame}?${clip.key}` : undefined,
        icon: 'wave',
        tint: picture ? undefined : TRACK_COLORS[part.lanes[0] % TRACK_COLORS.length],
        label: t('editor.span', { from: format.duration(part.from, 1), to: format.duration(part.to, 1) }),
        detail: `${what}, ${format.seconds(part.to - part.from)}`,
        run: () => commands.restore(part),
      };
    });
    showMenu({
      ...place,
      title: parts.length ? t('editor.clickRestore') : t('editor.overwritten'),
      items: [
        ...items,
        '-',
        parts.length > 1 && { icon: 'plus', tint: 'accent', label: t('editor.restoreAll'), run: () => commands.restoreEverything() },
        clip.hasPrevious && {
          icon: 'history',
          tint: 'accent',
          label: t('lib.revert'),
          detail: t('editor.undoOverwrite'),
          run: () => this.revert(),
        },
      ],
    });
  }

  clipMenu(event) {
    const { actions } = this.app;
    showMenu({
      anchor: event.currentTarget,
      keyboard: event.detail === 0,
      items: [
        { icon: 'title', label: t('actions.nameTitle'), hint: 'F2', run: () => this.editTitle() },
        { icon: 'game', label: t('lib.chooseGame'), run: () => actions.game([this.clip]) },
        { icon: 'tag', label: t('lib.tagsMenu'), hint: 'T', run: () => actions.tag([this.clip]) },
        '-',
        { icon: 'pencil', label: t('lib.renameFile'), run: () => this.rename() },
        { icon: 'folder', label: t('lib.reveal'), run: () => actions.reveal(this.clip) },
        this.clip.hasPrevious && {
          icon: 'history',
          tint: 'accent',
          label: t('lib.revert'),
          run: () => this.revert(),
        },
        '-',
        { icon: 'trash', label: t('lib.trash'), danger: true, run: () => this.trash() },
      ],
    });
  }

  overwrite() {
    if (!this.modified) {
      toast(t('editor.unchangedToast'));
      return;
    }
    this.player.pause();
    this.flush();
    openOverwrite(this.clip, outputEdit(this.edit), this.analysis, {
      onRunning: (running) => this.setReplacing(running),
      onSaved: async ({ id }) => {
        await this.reopen(id);
        toast(t('editor.overwrittenToast'));
      },
    });
  }

  async revert() {
    this.player.pause();
    if (!await this.app.actions.confirmRevert()) return;
    this.flush();
    this.setReplacing(true);
    const id = await this.app.actions.revert(this.clip);
    this.setReplacing(false);
    if (id) await this.reopen(id);
  }

  /** No edit may be saved while the file changes: it would land on the other version. */
  setReplacing(value) {
    this.replacing = value;
    this.root.inert = value;
  }

  /** Media URLs and edits belong to one file, so a replaced clip is opened again. */
  async reopen(id) {
    this.dirty = false;
    clearTimeout(this.saveTimer);
    const old = this.clip.id;
    const clip = (await call('state')).value?.clips.find((c) => c.id === id);
    if (clip) this.open(clip, this.order.map((other) => (other === old ? id : other)));
    else this.app.closeClip();
  }

  export() {
    this.player.pause();
    this.flush();
    openExport(this.clip, outputEdit(this.edit), this.analysis);
  }

  discord() {
    this.player.pause();
    this.flush();
    openDiscord(this.clip, outputEdit(this.edit));
  }

  async rename() {
    this.flush();
    const old = this.clip.id;
    const id = await this.app.actions.rename(this.clip);
    if (!id) return;
    const clip = this.app.clip(id) || (await call('state')).value?.clips.find((c) => c.id === id);
    // Media URLs contain the id, so reload.
    if (clip) this.open(clip, this.order.map((other) => (other === old ? id : other)));
  }

  async trash() {
    this.player.pause();
    this.flush();
    if (await this.app.actions.trash([this.clip])) this.app.closeClip();
  }

  step(direction) {
    const id = this.order[this.order.indexOf(this.clip.id) + direction];
    if (!id) return;
    this.flush();
    const next = this.app.clip(id);
    // The next clip plays if this one was playing.
    if (next) this.open(next, this.order, { play: this.player.playing });
  }

  escape() {
    if (this.timeline.cancel()) return;
    if (this.selection) this.select(null);
    else if (this.tool !== 'select') this.setTool('select');
    else this.app.closeClip();
  }

  key(event) {
    if (this.replacing) return;
    const { target } = event;
    if (target.matches('input:not([type="range"])')) {
      if (event.key === 'Escape') target.blur();
      return;
    }
    const key = event.key.toLowerCase();
    const { player, commands, timeline } = this;
    if (event.altKey && key === 'enter') {
      event.preventDefault();
      this.setVideoOnly(!this.videoOnly);
      return;
    }
    if (this.videoOnly) {
      if (!(event.ctrlKey ? VIDEO_CTRL_KEYS : VIDEO_KEYS).has(key)) return;
      this.alone.wake();
      if (key === 'escape' || (event.ctrlKey && key === 'i')) {
        event.preventDefault();
        if (key === 'escape') this.setVideoOnly(false);
        else this.alone.setDetails(!this.alone.detailsOpen);
        return;
      }
    }
    // Any other shortcut during a drag would edit under the pointer.
    if (timeline.gesture && key !== 'escape') {
      event.preventDefault();
      return;
    }
    const nudge = (direction) => {
      player.pause();
      player.seek(player.time + direction * (event.shiftKey ? 1 : 1 / (this.clip.fps || 30)));
    };

    const shortcuts = event.ctrlKey
      ? {
        z: () => this.travel(event.shiftKey ? 1 : -1),
        y: () => this.travel(1),
        e: () => this.export(),
        s: () => this.overwrite(),
        a: () => commands.selectAll(),
        c: () => commands.copy(),
        v: () => commands.paste(),
        d: () => commands.duplicate(),
        t: () => commands.transitionAtPlayhead(),
        x: () => event.shiftKey && commands.clearZone(),
        arrowleft: () => this.skip(-SKIP),
        arrowright: () => this.skip(SKIP),
        arrowup: () => this.moments.jump(-1),
        arrowdown: () => this.moments.jump(1),
      }
      : {
        ' ': () => player.toggle(),
        arrowleft: () => nudge(-1),
        arrowright: () => nudge(1),
        b: () => this.moments.mark(),
        t: () => this.app.actions.tag([this.clip]),
        f2: () => this.editTitle(),
        arrowup: () => commands.jumpToCut(-1),
        arrowdown: () => commands.jumpToCut(1),
        home: () => player.seek(0),
        end: () => player.seek(player.length),
        v: () => this.setTool('select'),
        c: () => this.setTool('razor'),
        x: () => this.setTool('razorTrack'),
        r: () => this.setTool('range'),
        n: () => this.setOption('magnet', !this.magnet),
        l: () => this.setOption('linked', !this.linked),
        s: () => commands.split(),
        i: () => commands.zoneEdge('start'),
        o: () => commands.zoneEdge('end'),
        m: () => commands.mute(),
        f: () => this.app.actions.favorite([this.clip]),
        '+': () => timeline.zoom(1.5),
        '=': () => timeline.zoom(1.5),
        '-': () => timeline.zoom(1 / 1.5),
        0: () => timeline.fit(),
        delete: () => commands.remove(),
        backspace: () => commands.remove(),
        escape: () => this.escape(),
      };
    if (!Object.hasOwn(shortcuts, key)) return;
    event.preventDefault();
    if (target.matches('button, input')) target.blur();
    shortcuts[key]();
  }

  teardown() {
    if (!this.clip) return;
    this.setVideoOnly(false);
    closeMenu();
    // Applies what was being typed, while the clip is still there to receive it.
    if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.flush();
    this.player.dispose();
    this.timeline.dispose();
    this.stageObserver.disconnect();
    // Let the pictures and waveforms of the closed clip go while the library shows. Pending answers
    // check the player first, so they end there.
    this.toolbar = null;
    this.player = null;
    this.timeline = null;
    this.commands = null;
    this.moments = null;
    this.analysis = null;
    this.history = [];
    this.lastTime = null;
    this.clip = null;
  }

  close() {
    this.teardown();
    this.root.hidden = true;
    this.root.replaceChildren();
    call('watching', null); // Its file may now move to the folder of its game.
  }
}
