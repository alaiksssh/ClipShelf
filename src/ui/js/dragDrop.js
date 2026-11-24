// Dragging inside the library: clips onto a folder, a tag, a game or the favourites, and tags onto clips.
// A clip dragged out of the window becomes a file drag, to drop it into Discord or the Explorer.
import { h, icon } from './dom.js';

const THRESHOLD = 6; // Pixels before a press becomes a drag.

/**
 * `payload` is what is dragged: ids of clips, or a tag. `onDrop(payload, target)` receives the
 * element under the pointer that accepts it, or nothing happens. `onLeave` is called when the pointer
 * leaves the window with clips, after which this drag is over.
 */
export function startDrag(event, { payload, label, symbol, accepts, onDrop, onLeave }) {
  if (event.button !== 0) return;
  const start = { x: event.clientX, y: event.clientY };
  let ghost = null;
  let target = null;

  const over = (x, y) => {
    const found = document.elementFromPoint(x, y)?.closest(accepts) || null;
    if (found === target) return;
    target?.classList.remove('drop-target');
    target = found;
    target?.classList.add('drop-target');
  };

  const stop = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    target?.classList.remove('drop-target');
    ghost?.remove();
    document.body.classList.remove('dragging-items');
  };

  function move(e) {
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;
      ghost = h('div', { class: 'drag-ghost' }, icon(symbol), h('span', {}, label));
      document.body.append(ghost);
      document.body.classList.add('dragging-items');
    }
    const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1;
    if (outside && onLeave) {
      stop();
      onLeave(payload);
      return;
    }
    ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
    over(e.clientX, e.clientY);
  }

  function up(e) {
    const dropped = ghost && target;
    stop();
    if (!ghost) return;
    // The click that ends a drag is not a click on what was dragged.
    const swallow = (click) => {
      click.stopImmediatePropagation();
      click.preventDefault();
    };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, true), 0);
    if (dropped) onDrop(payload, target, e);
  }

  function key(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    // Removed first: forgetting it before would leave it on screen.
    stop();
    ghost = null;
  }

  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
}
