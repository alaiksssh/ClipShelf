import { h } from './dom.js';
import { applyTheme } from './themes.js';
import { SHORTCUTS } from './shortcuts.js';
import { translatePage } from './i18n.js';

applyTheme(new URLSearchParams(location.search).get('theme'));
translatePage();

document.querySelector('#shortcuts').replaceChildren(...SHORTCUTS.map(([group, keys]) => h('section', {},
  h('h2', { class: 'caption' }, group),
  h('div', { class: 'keys' }, keys.flatMap(([key, text]) => [h('kbd', {}, key), h('span', {}, text)])))));

addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});
