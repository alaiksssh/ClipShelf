// Plays a montage live: reordered pieces, gaps, speeds and one independent source per audio track.
//
// Each lane owns two media elements. While one plays, the other is already waiting at the start
// of the next piece, so cuts play without a hitch. The picture drives the clock and the sound follows.
// During a transition both elements play: the outgoing piece past its end and the incoming one before
// its start, from the frames of the file around the cut. The picture is blended on screen (opacity,
// clip, move, a black or white veil) and the sound is crossfaded at constant power.
import { VIDEO, EPS, endOf, pieceAt, sourceAt, totalLength, volumeOf } from '/shared/pieces.mjs';
import { audibleTracks } from '/shared/edit.mjs';
import { transitionsOf, transitionAt, progressOf, crossfadeGains } from '/shared/transitions.mjs';
import { clamp } from '/shared/geometry.mjs';

const PRELOAD = 2; // Seconds before a piece starts.
const REUSE = 0.06; // An element this close to the wanted time needs no seek.
const SEEK_DRIFT = 0.2;
const NUDGE_DRIFT = 0.025;
const STALL_SOUND = 120; // Milliseconds of frozen picture before the sound waits for it.
const FADE = 0.006;

// What Chromium decodes straight from the clip; other first tracks are extracted.
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const keyOf = (piece) => `${piece.at.toFixed(4)}|${piece.from.toFixed(4)}|${piece.speed}`;
// The style of an element outside of transitions.
const NO_LOOK = { key: '', style: { opacity: '', transform: '', clipPath: '', zIndex: '' } };

/** The two media elements of one lane. */
class Deck {
  constructor(create, src, onError) {
    this.active = 0;
    this.key = null;
    this.slots = [0, 1].map(() => {
      const element = create();
      element.preload = 'auto';
      element.preservesPitch = true;
      const slot = { element, target: null };
      element.addEventListener('error', () => onError(slot));
      element.src = src;
      return slot;
    });
  }

  get current() {
    return this.slots[this.active];
  }

  get idle() {
    return this.slots[1 - this.active];
  }

  seek(slot, time) {
    slot.element.currentTime = time;
    slot.target = time;
  }

  /**
   * Makes `piece` current while playing, reusing whichever element is already in place. During a
   * transition (`blending`), the other element keeps playing the other piece.
   */
  enter(piece, time, blending = false) {
    const key = keyOf(piece);
    if (this.key === key) return;
    this.key = key;
    const wanted = sourceAt(piece, time);
    const near = (slot) => Math.abs(slot.element.currentTime - wanted) < REUSE && !slot.element.ended;
    if (!near(this.current)) {
      if (!blending) this.current.element.pause();
      this.active = 1 - this.active;
      if (!near(this.current)) this.seek(this.current, wanted);
    }
    if (!blending) this.idle.element.pause();
  }

  /** `leadOf(piece)` is how long before its start a piece plays, for the transition that leads to it. */
  prepare(pieces, lane, piece, time, leadOf = () => 0) {
    const after = piece ? endOf(piece) : time;
    let next = null;
    for (const other of pieces) {
      if (other.lane !== lane || other.muted || other.at < after - EPS) continue;
      if (!next || other.at < next.at) next = other;
    }
    if (!next || next.at - time > PRELOAD) return;
    const from = Math.max(0, next.from - leadOf(next) * next.speed);
    const continues = piece && Math.abs(next.at - after) < EPS && Math.abs(from - piece.to) < REUSE;
    const { idle } = this;
    if (continues || idle.target === from || idle.element.seeking) return;
    idle.element.pause();
    this.seek(idle, from);
  }

  /**
   * Keeps the idle element on `piece` at `time`, past the piece's own edges, for a transition. Where
   * the file has nothing, it holds still on its first or last frame.
   */
  hold(piece, time, playing, duration) {
    const slot = this.idle;
    const { element } = slot;
    const exact = sourceAt(piece, time);
    const wanted = clamp(exact, 0, Math.max(0, duration - 0.03));
    if (!playing || exact !== wanted) {
      if (!element.paused) element.pause();
      if (!element.seeking && (slot.target === null || Math.abs(slot.target - wanted) > 0.002)) this.seek(slot, wanted);
      return;
    }
    let rate = piece.speed;
    if (!element.seeking) {
      const drift = element.currentTime - wanted;
      if (Math.abs(drift) > SEEK_DRIFT) this.seek(slot, wanted);
      else if (Math.abs(drift) > NUDGE_DRIFT) rate *= drift > 0 ? 0.96 : 1.04;
    }
    if (element.playbackRate !== rate) element.playbackRate = rate;
    slot.target = null;
    if (element.paused && !element.error) element.play().catch(() => {});
  }

  /** Ends the use of the idle element by a transition. */
  stopHolding() {
    const { element } = this.idle;
    if (!element.paused) element.pause();
  }

  pause() {
    for (const slot of this.slots) {
      slot.element.pause();
      slot.target = null;
    }
    this.key = null;
  }

  setRate(rate) {
    if (this.current.element.playbackRate !== rate) this.current.element.playbackRate = rate;
  }

  start() {
    const { current } = this;
    current.target = null;
    if (current.element.paused && !current.element.error) current.element.play().catch(() => {});
  }

  release() {
    for (const { element } of this.slots) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
  }
}

export class Player {
  /** `getZone` returns the [start, end] that playback stays in, or null for the whole montage. */
  constructor({ clip, getEdit, getZone = () => null, onFrame, onPlayState, onError, onTrackError }) {
    Object.assign(this, { clip, getEdit, getZone, onFrame, onPlayState, onTrackError });
    this.time = 0;
    this.playing = false;
    this.stalledFor = 0;
    this.disposed = false;

    this.context = new AudioContext();
    this.master = this.context.createGain();
    // Same role as the export limiter: several loud tracks must not clip.
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    this.master.connect(limiter).connect(this.context.destination);

    let failed = false;
    this.picture = new Deck(() => {
      const video = document.createElement('video');
      video.muted = true;
      return video;
    }, `/media/${clip.id}?${clip.key}`, () => {
      if (this.disposed || failed) return;
      failed = true; // Both elements fail together.
      onError(() => { failed = false; });
    });
    this.sound = new Map();
    // Black or white over the picture, for fades and dips.
    this.veil = document.createElement('div');
    this.veil.className = 'veil';
    this.blending = false;
    this.cache = { pieces: null, lanes: new Map() };

    // A hidden window gets no frames, and without frames nothing would follow the montage.
    this.onHide = () => {
      if (document.hidden) this.pause();
    };
    document.addEventListener('visibilitychange', this.onHide);

    this.last = performance.now();
    this.tick = this.tick.bind(this);
    this.frame = requestAnimationFrame(this.tick);
  }

  get videos() {
    return this.picture.slots.map((slot) => slot.element);
  }

  /** The transitions of a lane, worked out once per montage. */
  transitions(pieces, lane) {
    if (this.cache.pieces !== pieces) this.cache = { pieces, lanes: new Map() };
    if (!this.cache.lanes.has(lane)) this.cache.lanes.set(lane, transitionsOf(pieces, lane));
    return this.cache.lanes.get(lane);
  }

  /** How long before its start a piece plays, for the transition at its cut. */
  leadOf(pieces, lane) {
    const list = this.transitions(pieces, lane);
    return (piece) => {
      const found = list.find((transition) => transition.left && transition.right?.id === piece.id);
      return found ? piece.at - found.start : 0;
    };
  }

  get length() {
    const { pieces, tracks } = this.getEdit();
    const audible = audibleTracks(tracks);
    return totalLength(pieces.filter((piece) => piece.lane === VIDEO || (audible[piece.lane] && !piece.muted)));
  }

  deckFor(index) {
    let deck = this.sound.get(index);
    if (deck) return deck;
    const extracted = `/track/${this.clip.id}/${index}?${this.clip.key}`;
    const direct = index === 0 && DIRECT_AUDIO.has(this.clip.audio[0].codec);

    deck = new Deck(() => new Audio(), direct ? `/media/${this.clip.id}?${this.clip.key}` : extracted, (slot) => {
      if (this.disposed) return;
      if (slot.element.src.includes('/media/')) slot.element.src = extracted;
      else this.onTrackError(index);
    });
    for (const slot of deck.slots) {
      slot.gain = this.context.createGain();
      slot.gain.gain.value = 0;
      slot.level = 0;
      this.context.createMediaElementSource(slot.element).connect(slot.gain).connect(this.master);
    }
    this.sound.set(index, deck);
    return deck;
  }

  setVolume(value) {
    this.master.gain.value = value;
  }

  seek(time) {
    this.time = Math.min(this.length, Math.max(0, time));
    this.picture.key = null;
    for (const deck of this.sound.values()) deck.key = null;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** The part of the montage that playback stays in. */
  get bounds() {
    const zone = this.getZone();
    const { length } = this;
    if (!zone || zone[1] - zone[0] < 0.05) return [0, length];
    return [Math.max(0, zone[0]), Math.min(length, zone[1])];
  }

  play() {
    const [start, end] = this.bounds;
    if (this.time < start - 0.001 || this.time >= end - 0.03) this.seek(start);
    this.playing = true;
    this.stalledFor = 0;
    this.context.resume();
    this.onPlayState(true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.picture.pause();
    for (const deck of this.sound.values()) deck.pause();
    this.onPlayState(false);
  }

  advance(pieces, elapsed) {
    const piece = pieceAt(pieces, VIDEO, this.time);
    const { element } = this.picture.current;
    if (!piece || element.error) {
      this.time += elapsed;
      this.stalledFor = 0;
      return;
    }
    if (this.picture.key !== keyOf(piece)) return; // Takes over on this frame.
    if (element.ended) {
      this.time = endOf(piece);
      return;
    }
    if (element.seeking || element.paused || element.readyState < 3) {
      this.stalledFor += elapsed * 1000;
      return;
    }
    this.stalledFor = 0;
    const time = piece.at + (element.currentTime - piece.from) / piece.speed;
    this.time = time >= endOf(piece) - 0.004 ? endOf(piece) : Math.max(piece.at, time);
  }

  tick(now) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const elapsed = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;

    const edit = this.getEdit();
    if (this.playing) {
      this.advance(edit.pieces, elapsed);
      const [start, end] = this.bounds;
      // In a selected zone playback loops, as the work area of After Effects does.
      if (end < this.length - 1e-4 && this.time >= end - 1e-4) this.seek(start);
      const { length } = this;
      if (this.time >= length - 1e-4) {
        this.time = length;
        this.pause();
      }
    }
    this.renderPicture(edit.pieces);
    this.renderSound(edit);
    this.onFrame(this.time);
  }

  renderPicture(pieces) {
    const deck = this.picture;
    const end = this.length;
    // At the very end, keep showing the last frame.
    const time = !this.playing && this.time >= end - 1e-4 ? Math.max(0, end - 0.01) : this.time;
    const piece = pieceAt(pieces, VIDEO, time);
    const transition = piece ? transitionAt(this.transitions(pieces, VIDEO), time) : null;
    const other = transition?.left && transition.right
      ? (piece.id === transition.left.id ? transition.right : transition.left)
      : null;

    if (piece && this.playing) {
      deck.enter(piece, time, Boolean(other));
      deck.setRate(piece.speed);
      deck.start();
    } else if (piece) {
      const { current } = deck;
      const wanted = Math.min(Math.max(0, this.clip.duration - 0.01), sourceAt(piece, time));
      current.element.pause();
      if (!current.element.seeking && (current.target === null || Math.abs(current.target - wanted) > 0.002)) {
        deck.seek(current, wanted);
      }
    } else {
      for (const slot of deck.slots) slot.element.pause();
      deck.key = null;
    }
    if (other) deck.hold(other, time, this.playing, this.clip.duration);
    else if (this.blending) deck.stopHolding();
    this.blending = Boolean(other);
    if (this.playing && !other) deck.prepare(pieces, VIDEO, piece, time, this.leadOf(pieces, VIDEO));

    const looks = transition ? this.blend(transition, progressOf(transition, time), piece, deck) : null;
    deck.slots.forEach(({ element }, i) => {
      let shown = Boolean(piece) && i === deck.active;
      if (looks) shown = looks.shown.includes(element);
      // Until the incoming element has a frame, keep the outgoing one on screen.
      else if (piece && this.playing && deck.current.element.seeking) shown = element.classList.contains('shown');
      element.classList.toggle('shown', shown);
      const look = looks?.styles.get(element) || NO_LOOK;
      if (element.dataset.look !== look.key) {
        element.dataset.look = look.key;
        Object.assign(element.style, look.style);
      }
    });
    const veil = looks?.veil || { color: '#000', opacity: 0 };
    if (this.veil.dataset.look !== `${veil.color}${veil.opacity}`) {
      this.veil.dataset.look = `${veil.color}${veil.opacity}`;
      this.veil.style.background = veil.color;
      this.veil.style.opacity = String(veil.opacity);
    }
  }

  /**
   * How the picture looks during a transition at `progress`: which elements show, their styles, and
   * the veil. The looks follow the xfade transitions of the export.
   */
  blend(transition, progress, piece, deck) {
    const styles = new Map();
    const look = (element, style) => styles.set(element, { key: JSON.stringify(style), style: { ...NO_LOOK.style, ...style } });
    const colour = transition.kind === 'white' ? '#fff' : '#000';
    const p = progress;
    if (!transition.left || !transition.right) {
      const element = deck.current.element;
      look(element, {});
      // From black at a start, to black at an end.
      return { shown: [element], styles, veil: { color: colour, opacity: Number((transition.right ? 1 - p : p).toFixed(3)) } };
    }
    const mine = deck.current.element;
    const theirs = deck.idle.element;
    const left = piece.id === transition.left.id ? mine : theirs;
    const right = left === mine ? theirs : mine;
    switch (transition.kind) {
      case 'black':
      case 'white': {
        const shown = p < 0.5 ? left : right;
        look(shown, {});
        return { shown: [shown], styles, veil: { color: colour, opacity: Number((p < 0.5 ? p * 2 : (1 - p) * 2).toFixed(3)) } };
      }
      case 'wipe':
        look(left, { zIndex: '1' });
        look(right, { zIndex: '2', clipPath: `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)` });
        break;
      case 'slide':
        look(left, { transform: `translateX(${(-p * 100).toFixed(2)}%)` });
        look(right, { transform: `translateX(${((1 - p) * 100).toFixed(2)}%)` });
        break;
      case 'iris':
        look(left, { zIndex: '1' });
        look(right, { zIndex: '2', clipPath: `circle(${(p * 71).toFixed(2)}% at 50% 50%)` });
        break;
      case 'zoom':
        look(right, { zIndex: '1' });
        look(left, { zIndex: '2', opacity: (1 - p).toFixed(3), transform: `scale(${(1 + p * 0.6).toFixed(3)})` });
        break;
      default: // dissolve
        look(left, { zIndex: '1' });
        look(right, { zIndex: '2', opacity: p.toFixed(3) });
    }
    return { shown: [left, right], styles, veil: null };
  }

  renderSound({ pieces, tracks }) {
    const audible = audibleTracks(tracks);
    const waiting = this.stalledFor > STALL_SOUND;

    tracks.forEach((track, index) => {
      if (!audible[index] && !this.sound.has(index)) return;
      const deck = this.deckFor(index);
      const piece = pieceAt(pieces, index, this.time);
      const live = audible[index] && piece && !piece.muted;
      const transition = live ? transitionAt(this.transitions(pieces, index), this.time) : null;
      const running = live && this.playing && !waiting;
      const other = running && transition?.left && transition.right
        ? (piece.id === transition.left.id ? transition.right : transition.left)
        : null;

      if (running) this.follow(deck, piece, Boolean(other));
      else {
        for (const slot of deck.slots) if (!slot.element.paused) slot.element.pause();
        deck.key = null;
        // While paused, wait in place so that playback starts at once.
        if (live && !this.playing && !deck.current.element.seeking) {
          const wanted = sourceAt(piece, this.time);
          if (deck.current.target === null || Math.abs(deck.current.target - wanted) > 0.002) deck.seek(deck.current, wanted);
        }
      }
      if (other) deck.hold(other, this.time, true, this.clip.duration);
      else if (deck.blending) deck.stopHolding();
      deck.blending = Boolean(other);
      if (this.playing && audible[index] && !other) deck.prepare(pieces, index, piece, this.time, this.leadOf(pieces, index));

      // Constant power across a cut; a fade from or to silence at an edge.
      let mine = 1;
      let theirs = 0;
      if (transition) {
        const [out, into] = crossfadeGains(progressOf(transition, this.time));
        if (other) [mine, theirs] = piece.id === transition.left.id ? [out, into] : [into, out];
        else mine = transition.right ? into : out;
      }
      deck.slots.forEach((slot, i) => {
        let gain = 0;
        if (running && i === deck.active) gain = track.volume * volumeOf(piece) * mine;
        else if (other && i !== deck.active) gain = track.volume * volumeOf(other) * theirs;
        if (Math.abs(gain - slot.level) < 1e-4) return;
        slot.level = gain;
        slot.gain.gain.setTargetAtTime(gain, this.context.currentTime, FADE);
      });
    });
  }

  follow(deck, piece, blending = false) {
    deck.enter(piece, this.time, blending);
    const { element } = deck.current;
    const wanted = sourceAt(piece, this.time);
    if (element.duration && wanted >= element.duration - 0.03) {
      element.pause(); // This track is shorter than the picture; play() would restart it from zero.
      return;
    }
    let rate = piece.speed;
    if (!element.seeking) {
      const drift = element.currentTime - wanted;
      if (Math.abs(drift) > SEEK_DRIFT) deck.seek(deck.current, wanted);
      else if (Math.abs(drift) > NUDGE_DRIFT) rate *= drift > 0 ? 0.96 : 1.04;
    }
    deck.setRate(rate);
    deck.start();
  }

  useProxy() {
    for (const slot of this.picture.slots) {
      slot.element.src = `/proxy/${this.clip.id}?${this.clip.key}`;
      slot.target = null;
    }
    this.picture.key = null;
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onHide);
    cancelAnimationFrame(this.frame);
    this.picture.release();
    for (const deck of this.sound.values()) deck.release();
    this.context.close();
  }
}
