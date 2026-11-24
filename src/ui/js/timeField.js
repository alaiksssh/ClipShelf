// The current time, as in After Effects: drag it sideways to move in time, click it to type a time.
import { h } from './dom.js';
import * as format from './format.js';
import { t } from './i18n.js';

const DRAG = 3; // Pixels before a press becomes a drag.

/** "1:02.5", "62.5", "62,5" or "1:02:03" in seconds, or null. */
export function parseTime(text) {
  const parts = text.trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(\.\d*)?$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function timeField({ player, fps, onSeek }) {
  const now = h('span', { class: 'time-now' });
  const input = h('input', {
    class: 'time-input',
    hidden: true,
    spellcheck: 'false',
    'aria-label': t('time.goTo'),
  });
  const el = h('span', {
    class: 'time-scrub',
    title: t('time.hint'),
  }, now);
  const seek = (time) => {
    player.seek(time);
    onSeek(player.time);
  };

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    let last = event.clientX;
    let time = player.time;
    const playing = player.playing;
    let dragged = false;

    el.onpointermove = (e) => {
      if (!dragged && Math.abs(e.clientX - last) < DRAG) return;
      if (!dragged) {
        dragged = true;
        player.pause();
        el.classList.add('dragging');
      }
      // One frame per pixel; Shift goes ten times faster, Ctrl ten times finer, from where it is now.
      const step = (1 / fps) * (e.shiftKey ? 10 : 1) * (e.ctrlKey ? 0.1 : 1);
      time = Math.max(0, Math.min(player.length, time + (e.clientX - last) * step));
      last = e.clientX;
      seek(time);
    };
    el.onpointerup = () => {
      el.onpointermove = null;
      el.onpointerup = null;
      el.classList.remove('dragging');
      if (!dragged) edit();
      else if (playing) player.play();
    };
  });

  function edit() {
    player.pause();
    input.value = format.duration(player.time, 2);
    el.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  function close(apply) {
    if (input.hidden) return;
    const time = parseTime(input.value);
    input.hidden = true;
    el.hidden = false;
    if (apply && time !== null) seek(time);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(event.key === 'Enter');
  });
  input.addEventListener('blur', () => close(true));

  return {
    els: [el, input],
    show(time) {
      now.textContent = format.duration(time, 2);
    },
  };
}
