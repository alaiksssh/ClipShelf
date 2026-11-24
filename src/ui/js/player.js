// Plays a montage live: reordered pieces, gaps, speeds and one independent source per audio track.
//
// Each lane owns two media elements. While one plays, the other is already waiting at the start
// of the next piece, so cuts play without a hitch. The picture drives the clock and the sound follows.
import { VIDEO, EPS, endOf, pieceAt, sourceAt, totalLength, volumeOf } from '/shared/pieces.mjs';
import { audibleTracks } from '/shared/edit.mjs';

const PRELOAD = 2; // Seconds before a piece starts.
const REUSE = 0.06; // An element this close to the wanted time needs no seek.
const SEEK_DRIFT = 0.2;
const NUDGE_DRIFT = 0.025;
const STALL_SOUND = 120; // Milliseconds of frozen picture before the sound waits for it.
const FADE = 0.006;

// What Chromium decodes straight from the clip; other first tracks are extracted.
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const keyOf = (piece) => `${piece.at.toFixed(4)}|${piece.from.toFixed(4)}|${piece.speed}`;

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

  /** Makes `piece` current while playing, reusing whichever element is already in place. */
  enter(piece, time) {
    const key = keyOf(piece);
    if (this.key === key) return;
    this.key = key;
    const wanted = sourceAt(piece, time);
    const near = (slot) => Math.abs(slot.element.currentTime - wanted) < REUSE && !slot.element.ended;
    if (!near(this.current)) {
      this.current.element.pause();
      this.active = 1 - this.active;
      if (!near(this.current)) this.seek(this.current, wanted);
    }
    this.idle.element.pause();
  }

  prepare(pieces, lane, piece, time) {
    const after = piece ? endOf(piece) : time;
    let next = null;
    for (const other of pieces) {
      if (other.lane !== lane || other.muted || other.at < after - EPS) continue;
      if (!next || other.at < next.at) next = other;
    }
    if (!next || next.at - time > PRELOAD) return;
    const continues = piece && Math.abs(next.at - after) < EPS && Math.abs(next.from - piece.to) < REUSE;
    const { idle } = this;
    if (continues || idle.target === next.from || idle.element.seeking) return;
    idle.element.pause();
    this.seek(idle, next.from);
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

    if (piece && this.playing) {
      deck.enter(piece, time);
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
    if (this.playing) deck.prepare(pieces, VIDEO, piece, time);

    deck.slots.forEach(({ element }, i) => {
      let shown = Boolean(piece) && i === deck.active;
      // Until the incoming element has a frame, keep the outgoing one on screen.
      if (piece && this.playing && deck.current.element.seeking) shown = element.classList.contains('shown');
      element.classList.toggle('shown', shown);
    });
  }

  renderSound({ pieces, tracks }) {
    const audible = audibleTracks(tracks);
    const waiting = this.stalledFor > STALL_SOUND;

    tracks.forEach((track, index) => {
      if (!audible[index] && !this.sound.has(index)) return;
      const deck = this.deckFor(index);
      const piece = pieceAt(pieces, index, this.time);
      const live = audible[index] && piece && !piece.muted;

      if (live && this.playing && !waiting) this.follow(deck, piece);
      else {
        for (const slot of deck.slots) if (!slot.element.paused) slot.element.pause();
        deck.key = null;
        // While paused, wait in place so that playback starts at once.
        if (live && !this.playing && !deck.current.element.seeking) {
          const wanted = sourceAt(piece, this.time);
          if (deck.current.target === null || Math.abs(deck.current.target - wanted) > 0.002) deck.seek(deck.current, wanted);
        }
      }
      if (this.playing && audible[index]) deck.prepare(pieces, index, piece, this.time);

      deck.slots.forEach((slot, i) => {
        const gain = live && this.playing && i === deck.active ? track.volume * volumeOf(piece) : 0;
        if (gain === slot.level) return;
        slot.level = gain;
        slot.gain.gain.setTargetAtTime(gain, this.context.currentTime, FADE);
      });
    });
  }

  follow(deck, piece) {
    deck.enter(piece, this.time);
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
