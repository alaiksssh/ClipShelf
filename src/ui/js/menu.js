// Every menu of the app: right click, drop-down lists and pop-up lists.
import { h, icon } from './dom.js';

const MARGIN = 8; // From the edges of the window.
const GAP = 6; // Below or above what opened it.

let current = null;

export function closeMenu() {
  current?.close();
}

function row(item, { selectable, choose }) {
  const picture = item.image
    ? h('img', { class: 'menu-thumb', src: item.image, alt: '', draggable: 'false' })
    : item.icon && h('span', { class: 'menu-icon' }, icon(item.icon));
  return h('button', {
    class: `menu-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`,
    role: selectable ? 'menuitemradio' : 'menuitem',
    'aria-checked': selectable ? String(Boolean(item.checked)) : null,
    tabindex: -1,
    style: item.tint ? { '--tint': `var(--${item.tint})` } : {},
    onPointermove: (event) => event.currentTarget.focus({ preventScroll: true }),
    onClick: () => choose(item),
  },
  picture,
  h('span', { class: 'menu-text' },
    h('span', { class: 'menu-label' }, item.label),
    item.detail && h('small', {}, item.detail)),
  item.hint && h('kbd', {}, item.hint),
  selectable && h('span', { class: 'menu-tick' }, item.checked && icon('tick')));
}

/**
 * An item is { label, run, icon or image, detail, hint, tint, danger, checked }. '-' draws a line and
 * falsy items are skipped. With `anchor`, the menu hangs from that element instead of x and y.
 */
export function showMenu({ items, x = 0, y = 0, anchor, title, selectable = false, keyboard = false }) {
  const reopened = anchor && current?.anchor === anchor;
  closeMenu();
  if (reopened) return; // A second click on what opened it closes it.

  const choose = (item) => {
    close();
    item.run();
  };
  const list = items.filter(Boolean).filter((item, i, all) =>
    item !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
  if (!list.length) return;

  const children = list.map((item) =>
    (item === '-' ? h('div', { class: 'menu-line', role: 'separator' }) : row(item, { selectable, choose })));
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: -1 },
    title && h('div', { class: 'menu-title' }, title),
    h('div', { class: 'menu-list' }, children));
  const rows = children.filter((el) => el.matches('button'));
  // A menu outside of an open dialog would be under it.
  const dialog = anchor?.closest('dialog');

  function close() {
    if (current?.menu !== menu) return;
    current = null;
    const hadFocus = menu.contains(document.activeElement);
    menu.remove();
    anchor?.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', keys, true);
    removeEventListener('wheel', outside, true);
    removeEventListener('blur', close);
    removeEventListener('resize', close);
    // Elsewhere, focus goes back to the page, where the shortcuts are.
    if (hadFocus && anchor?.isConnected && (keyboard || dialog)) anchor.focus({ preventScroll: true });
  }

  function outside(event) {
    if (menu.contains(event.target)) return;
    if (event.type === 'pointerdown' && anchor?.contains(event.target)) return;
    close();
  }

  function keys(event) {
    const focused = rows.indexOf(document.activeElement);
    // Arrows start from the current value of a list.
    const at = focused < 0 ? rows.findIndex((el) => el.matches('.checked')) : focused;
    const moves = {
      ArrowDown: at < 0 ? 0 : (at + 1) % rows.length,
      ArrowUp: at <= 0 ? rows.length - 1 : at - 1,
      Home: 0,
      End: rows.length - 1,
    };
    if (event.key === 'Escape' || event.key === 'Tab') close();
    else if (Object.hasOwn(moves, event.key)) rows[moves[event.key]].focus();
    else return;
    event.preventDefault(); // Escape would also close the dialog.
    event.stopPropagation();
  }

  (dialog || document.body).append(menu);
  current = { menu, anchor, close };

  let left = x;
  let top = y;
  let above = y;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(180, box.width)}px`;
    left = box.left;
    top = box.bottom + GAP;
    above = box.top - GAP;
    anchor.setAttribute('aria-expanded', 'true');
  }
  const { offsetWidth: width, offsetHeight: height } = menu;
  if (top + height > innerHeight - MARGIN) top = above - height;
  menu.style.left = `${Math.max(MARGIN, Math.min(left, innerWidth - width - MARGIN))}px`;
  menu.style.top = `${Math.max(MARGIN, Math.min(top, innerHeight - height - MARGIN))}px`;

  const checked = children.find((el) => el.matches('.checked'));
  if (keyboard) (checked || rows[0]).focus();
  else menu.focus({ preventScroll: true });
  checked?.scrollIntoView({ block: 'nearest' });

  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', keys, true);
  addEventListener('wheel', outside, { capture: true, passive: true });
  addEventListener('blur', close);
  addEventListener('resize', close);
}

/**
 * Replaces <select>, whose list Windows draws in its own style.
 * Options are { value, label, detail, icon }. The element has a `value`, like a select.
 */
export function dropdown({ options, value, onChange, class: extra = '', title }) {
  let selected = value;
  const label = h('span', { class: 'dropdown-label' });
  const show = () => {
    label.textContent = options.find((option) => option.value === selected)?.label ?? '';
  };
  const open = (keyboard) => showMenu({
    anchor: el,
    keyboard,
    selectable: true,
    items: options.map((option) => ({
      ...option,
      checked: option.value === selected,
      run: () => {
        if (option.value === selected) return;
        selected = option.value;
        show();
        onChange?.(selected);
      },
    })),
  });

  const el = h('button', {
    type: 'button',
    class: `field dropdown ${extra}`,
    title,
    'aria-label': title,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onClick: (event) => open(event.detail === 0),
    onKeydown: (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      open(true);
    },
  }, label, icon('down'));

  Object.defineProperty(el, 'value', {
    get: () => selected,
    set: (next) => {
      selected = next;
      show();
    },
  });
  show();
  return el;
}
