// The muted preview of the card under the pointer. A clip with a montage previews the montage, as
// it would be exported: its pieces in order, at their speed and in their frame.
import { h } from './dom.js';
import { previewOf } from '/shared/edit.mjs';

const START = 0.3; // Of an unedited clip: past the usual quiet start.
const BOX = 16 / 9; // The shape of a thumbnail. Keep in sync with library.css.
// A run ends this much early, so that no frame of what was cut ever shows.
const EARLY = 0.03;

export class Preview {
  constructor(clip) {
    this.clip = clip;
    this.video = h('video', { src: `/media/${clip.id}?${clip.key}` });
    this.video.muted = true;
    const plan = previewOf(clip.edit, clip);
    this.runs = plan?.runs;
    this.el = plan?.crop ? framed(this.video, clip, plan.crop) : this.video;
    this.video.addEventListener('error', () => this.el.remove());

    if (this.runs) {
      this.enter(0);
      this.tick = this.tick.bind(this);
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.video.loop = true;
      this.video.currentTime = clip.duration * START;
    }
    this.video.play().catch(() => {}); // Interrupted when the pointer leaves.
  }

  /** Into the thumbnail of a card, which may be a new one: moving the video pauses it. */
  moveTo(thumb) {
    thumb.querySelector('.badge').before(this.el);
    this.video.play().catch(() => {});
  }

  enter(index) {
    const run = this.runs[index];
    this.index = index;
    this.video.currentTime = run.from;
    this.video.playbackRate = run.speed;
  }

  tick() {
    const run = this.runs[this.index];
    if (this.video.ended || this.video.currentTime >= run.to - EARLY) {
      this.enter((this.index + 1) % this.runs.length);
      if (this.video.paused) this.video.play().catch(() => {});
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.video.removeAttribute('src');
    this.video.load();
    this.el.remove();
  }
}

/** The video cut to `crop`, centred on black in the thumbnail. */
function framed(video, clip, crop) {
  const ratio = crop.w / crop.h;
  const width = ratio < BOX ? (ratio / BOX) * 100 : 100;
  const height = ratio < BOX ? 100 : (BOX / ratio) * 100;
  Object.assign(video.style, {
    left: `${(-crop.x / crop.w) * 100}%`,
    top: `${(-crop.y / crop.h) * 100}%`,
    width: `${(clip.width / crop.w) * 100}%`,
    height: `${(clip.height / crop.h) * 100}%`,
  });
  return h('div', { class: 'preview-backdrop' },
    h('div', {
      class: 'preview-frame',
      style: { width: `${width}%`, height: `${height}%` },
    }, video));
}
