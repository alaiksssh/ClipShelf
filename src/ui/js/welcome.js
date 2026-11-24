// The welcome screen of a first start: language, clip folders, export folder, then what was chosen
// and the shortcuts worth knowing. Each choice is saved at once, as in the settings, so that leaving
// at any step keeps what was chosen. The main process shows it again once its file is deleted.
import { h, button, icon, call } from './dom.js';
import { t, language } from './i18n.js';
import { LANGUAGES } from '/shared/i18n.mjs';

const STEPS = ['language', 'clips', 'exports', 'ready'];

/** Shortcuts worth knowing from the start, by place. The settings show them all. */
const SHORTCUTS = [
  [t('welcome.inLibrary'), [
    [t('key.dblclick'), t('welcome.openClip')],
    ['Ctrl + K', t('palette.title')],
    ['Ctrl + F', t('lib.find')],
    ['F2', t('actions.nameTitle')],
    ['T', t('lib.tags')],
    ['C', t('sc.category')],
    ['F', t('sc.favorite')],
    [t('key.ctrlClick'), t('sc.several')],
    [t('sc.dragClipKey'), t('sc.dragClip')],
    [t('key.delete'), t('sc.trash')],
  ]],
  [t('welcome.inEditor'), [
    [t('key.space'), t('sc.playPause')],
    ['← →', t('sc.frames')],
    ['Ctrl + ← →', t('sc.skip')],
    ['I / O', t('sc.zone')],
    ['S', t('sc.split')],
    ['B', t('sc.mark')],
    ['M', t('sc.mute')],
    ['Ctrl + Z / Y', t('sc.undo')],
    ['Ctrl + E', t('export.title')],
    ['Ctrl + S', t('sc.overwrite')],
  ]],
];

export function openWelcome(app) {
  let step = 0;
  let info = null;
  const body = h('div', { class: 'welcome-body' });
  const progress = h('span', { class: 'welcome-step' });
  const dots = h('div', { class: 'welcome-dots', 'aria-hidden': 'true' });
  const back = button({ icon: 'back', label: t('welcome.back'), onClick: () => go(step - 1) });
  const next = button({ label: t('welcome.next'), class: 'primary', onClick: () => go(step + 1) });
  const skip = button({ label: t('welcome.skip'), class: 'ghost', onClick: () => finish() });

  const dialog = h('dialog', { class: 'welcome' },
    h('header', { class: 'welcome-head' },
      h('img', { src: 'icon.png', alt: '' }),
      h('div', {}, h('h2', {}, t('welcome.title')), progress),
      dots),
    body,
    h('div', { class: 'dialog-actions' }, skip, h('span', { class: 'grow' }), back, next));
  // Escape would leave the screen without its file written: it would come back at every start.
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  document.body.append(dialog);
  dialog.showModal();

  const unsubscribe = app.subscribe(() => refresh());

  async function refresh() {
    if (STEPS[step] === 'clips') {
      const { ok, value } = await call('welcomeInfo');
      if (ok) info = value;
    }
    render();
  }

  function go(to) {
    if (to >= STEPS.length) {
      finish();
      return;
    }
    step = Math.max(0, to);
    refresh();
  }

  async function finish() {
    const { ok } = await call('welcomeDone');
    if (!ok) return;
    unsubscribe();
    dialog.close();
    dialog.remove();
  }

  function render() {
    const name = STEPS[step];
    dialog.dataset.step = name;
    progress.textContent = t('welcome.step', { n: step + 1, total: STEPS.length });
    dots.replaceChildren(...STEPS.map((_, i) => h('i', { class: i === step ? 'on' : i < step ? 'done' : '' })));
    back.hidden = step === 0;
    skip.hidden = step === STEPS.length - 1;
    next.replaceChildren(t(step === STEPS.length - 1 ? 'welcome.start' : 'welcome.next'));
    const parts = ({ language: languageStep, clips: clipsStep, exports: exportsStep, ready: readyStep })[name]();
    body.replaceChildren(...parts.filter(Boolean));
    // "Suivant" holds the focus unless a choice of the step has it, so Enter goes on through the steps.
    if (!body.contains(document.activeElement)) next.focus();
  }

  function languageStep() {
    return [
      h('h3', {}, t('welcome.languageTitle')),
      h('p', {}, t('welcome.intro')),
      h('div', { class: 'welcome-languages', role: 'radiogroup', 'aria-label': t('settings.language') },
        ...LANGUAGES.map(({ id, name }) => h('label', { class: 'choice' },
          h('input', {
            type: 'radio',
            name: 'language',
            checked: id === language,
            // The main process opens the page again in that language, on this first step.
            onChange: () => call('setLanguage', id),
          }),
          h('b', {}, name)))),
    ];
  }

  function clipsStep() {
    const { folders } = app.state;
    return [
      h('h3', {}, t('welcome.clipsTitle')),
      h('p', {}, t('welcome.clipsText')),
      ...folders.map((folder) => h('div', { class: `folder-row ${folder.online ? '' : 'offline'}`, 'data-folder': folder.path },
        h('span', {}, folder.online ? folder.path : t('settings.offline', { path: folder.path })),
        button({ icon: 'close', title: t('settings.removeFolder'), class: 'ghost', onClick: () => call('removeFolder', folder.path) }))),
      folders.length === 0 && h('div', { class: 'notice warn' }, icon('folder'), h('span', {}, t('welcome.noFolder'))),
      button({ icon: 'plus', label: t('settings.addFolder'), onClick: () => call('addFolder') }),
      ...obsNotices(),
    ];
  }

  /** What OBS says about where it records. Read from OBS, which is never changed. */
  function obsNotices() {
    if (!info) return [];
    const how = h('small', {}, t('welcome.obsHow'));
    if (!info.obs.folders.length) {
      return [h('div', { class: 'notice warn obs' }, icon('folder'), h('span', {}, h('b', {}, t('welcome.obsNone')), how))];
    }
    return info.obs.folders.map((folder) => {
      if (folder.covered) {
        return h('div', { class: 'notice obs' }, icon('tick'),
          h('span', {}, h('b', {}, t('welcome.obsHere')), folder.path));
      }
      const text = folder.exists ? t('welcome.obsElsewhere', { path: folder.path }) : t('welcome.obsMissing', { path: folder.path });
      return h('div', { class: 'notice warn obs' }, icon('folder'),
        h('span', {}, h('b', {}, text), how),
        folder.exists && button({ icon: 'plus', label: t('welcome.addObs'), onClick: () => call('addObsFolder', folder.path) }));
    });
  }

  function exportsStep() {
    return [
      h('h3', {}, t('welcome.exportsTitle')),
      h('p', {}, t('welcome.exportsText')),
      h('div', { class: 'folder-row' }, h('span', {}, app.state.exportDir),
        button({ label: t('common.change'), class: 'ghost', onClick: () => call('setExportDir') })),
    ];
  }

  function readyStep() {
    const languageName = LANGUAGES.find(({ id }) => id === language)?.name || language;
    const summary = [
      [t('settings.language'), languageName],
      [t('welcome.clipsLabel'), app.state.folders.map((folder) => folder.path).join('\n') || t('welcome.noFolder')],
      [t('settings.exportDir'), app.state.exportDir],
    ];
    return [
      h('h3', {}, t('welcome.readyTitle')),
      h('dl', { class: 'welcome-summary' }, ...summary.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
      h('h3', {}, t('shortcuts.title')),
      h('div', { class: 'welcome-shortcuts' }, ...SHORTCUTS.map(([place, keys]) => h('section', {},
        h('h4', {}, place),
        h('div', { class: 'keys' }, ...keys.flatMap(([key, text]) => [h('kbd', {}, key), h('span', {}, text)]))))),
      h('div', { class: 'welcome-more' },
        button({ icon: 'keyboard', label: t('settings.showShortcuts'), class: 'ghost', onClick: () => call('showShortcuts') })),
    ];
  }

  render();
}
