import { ICONS, VIEWBOX } from './icons.js';

/**
 * Builds an element. Children given as strings become text nodes, so file names can't inject HTML.
 * Props: class, style (object, custom properties allowed), onEvent handlers, or attributes.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked') el[key] = value;
    // Shown by tooltip.js, at once and with its shortcut, instead of the slow tooltip of Windows.
    else if (key === 'title') el.dataset.tip = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', VIEWBOX);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

export function button({ icon: name, label, title, class: extra = '', ...props }) {
  return h('button', {
    class: `btn ${label ? '' : 'square'} ${extra}`,
    title,
    'aria-label': label ? null : title,
    ...props,
  }, name && icon(name), label);
}

/** A range input with a filled track. Use setSlider to change it from code. */
export function slider({ value, onInput, ...props }) {
  const el = h('input', {
    type: 'range',
    ...props,
    onInput: () => {
      fillSlider(el);
      onInput?.(Number(el.value));
    },
  });
  setSlider(el, value);
  return el;
}

function fillSlider(el) {
  const min = Number(el.min);
  el.style.setProperty('--fill', `${((el.value - min) / (Number(el.max) - min)) * 100}%`);
}

export function setSlider(el, value) {
  el.value = value;
  fillSlider(el);
}

export function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.querySelector('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

/** Unwraps a bridge result and shows the error when there is one. */
export async function call(method, ...args) {
  const { value, error } = await window.bridge[method](...args);
  if (!error) return { ok: true, value };
  toast(error, 'error');
  return { ok: false, error };
}

export function remember(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
