// Tooltips for every element with a `data-tip` (h() puts `title` there). They show sooner than the
// tooltips of Windows, at once when moving from one to the next, and with the shortcut of a text
// that ends with one in brackets, such as "Exporter (Ctrl+E)". One element serves them all.
import { h } from './dom.js';
import { splitTip } from '/shared/tips.mjs';

const DELAY = 450; // Milliseconds over an element before its tooltip shows.
const WARM = 500; // Milliseconds after one hides during which the next shows at once.
const GAP = 8;

export function installTooltips() {
  const tip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  let current = null;
  let timer = 0;
  let warmUntil = 0;

  const hide = () => {
    clearTimeout(timer);
    if (!tip.hidden) warmUntil = performance.now() + WARM;
    tip.hidden = true;
    current = null;
  };

  const show = (target) => {
    if (!target.isConnected || !target.dataset.tip) return;
    const { label, key, details } = splitTip(target.dataset.tip);
    tip.replaceChildren(
      h('span', { class: 'tooltip-label' }, label, ...details.map((line) => h('small', {}, line))),
      key && h('kbd', {}, key));
    // A modal dialog is drawn above everything else: the tooltip goes inside it to be seen.
    const layer = target.closest('dialog[open]') || document.body;
    if (tip.parentElement !== layer) layer.append(tip);
    tip.style.transform = 'translate(-9999px, 0)';
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    let top = box.bottom + GAP;
    if (top + height > innerHeight - GAP) top = box.top - height - GAP;
    const left = Math.min(Math.max(GAP, box.left + box.width / 2 - width / 2), innerWidth - width - GAP);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(GAP, top))}px)`;
  };

  addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target === current) return;
    hide();
    if (!target?.dataset.tip || event.pointerType === 'touch') return;
    current = target;
    timer = setTimeout(() => show(target), performance.now() < warmUntil ? 0 : DELAY);
  });
  addEventListener('pointerout', (event) => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  for (const type of ['pointerdown', 'wheel', 'keydown', 'blur']) addEventListener(type, hide, { capture: true, passive: true });
}
