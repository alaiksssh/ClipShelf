// The volume of a track as a percentage that can be typed.
import { h } from './dom.js';
import { MAX_VOLUME } from '/shared/edit.mjs';
import { clamp } from '/shared/geometry.mjs';
import { t } from './i18n.js';

const MAX_PERCENT = MAX_VOLUME * 100;

const show = (percent) => `${String(Number(percent.toFixed(1))).replace('.', ',')}%`;

/** "150", "150 %" and "87,5" are understood. Anything else gives null. */
function parse(text) {
  const match = /^(\d+(?:[.,]\d*)?|[.,]\d+)\s*%?$/.exec(text.trim());
  return match ? clamp(Number(match[1].replace(',', '.')), 0, MAX_PERCENT) : null;
}

/**
 * Enter or leaving the field applies, Escape cancels, the arrows step by 1 (10 with Shift).
 * `onPreview` is heard at once, `onApply` ends up as one step of the history.
 */
export function volumeField({ onPreview, onApply }) {
  let before = 100;
  let value = 100;

  const el = h('input', {
    class: 'volume-value',
    type: 'text',
    inputmode: 'decimal',
    maxlength: 7,
    spellcheck: 'false',
    autocomplete: 'off',
    title: t('volume.hint', { max: MAX_PERCENT }),
    'aria-label': t('volume.label'),
    onFocus: () => {
      before = value;
      el.value = show(value).slice(0, -1);
      el.select();
    },
    // Without this, the click would undo the selection made on focus.
    onMousedown: (event) => {
      if (document.activeElement === el) return;
      event.preventDefault();
      el.focus();
    },
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        value = before;
        el.value = show(before);
        onPreview(before / 100);
        el.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
        value = clamp((parse(el.value) ?? value) + step, 0, MAX_PERCENT);
        el.value = show(value).slice(0, -1);
        el.select();
        onPreview(value / 100);
      }
    },
    onBlur: () => {
      const typed = parse(el.value) ?? before;
      value = typed;
      el.value = show(typed);
      if (Math.abs(typed - before) > 1e-6) onApply(typed / 100);
      else onPreview(before / 100);
    },
  });

  return {
    el,
    set(volume) {
      if (document.activeElement === el) return; // Never overwrite what is being typed.
      value = volume * 100;
      el.value = show(value);
    },
  };
}
