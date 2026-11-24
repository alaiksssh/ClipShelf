import { h, button, icon, call, remember, store, toast } from './dom.js';
import { THEMES } from './themes.js';
import { dropdown } from './menu.js';
import { gameBadge } from './gameBadge.js';
import * as format from './format.js';
import { t, language } from './i18n.js';
import { LANGUAGES } from '/shared/i18n.mjs';

/**
 * How a clip is made ready for Discord. "Intacte" keeps the picture of the clip and stays under what
 * Nitro takes (500 MB); the others squeeze it under what Discord takes with Nitro Basic or without
 * Nitro.
 */
export const DISCORD_CHOICES = [
  { value: 'intact', label: t('discord.intact'), detail: t('discord.intactDetail') },
  { value: 50, label: t('discord.max50'), detail: 'Nitro Basic' },
  { value: 10, label: t('discord.max10'), detail: t('discord.noNitro') },
];

export const discordLimitOf = (choice) => (choice === 'intact' ? 500 : choice);

export const discordChoice = () => {
  const value = remember('discordLimit', 'intact');
  // Nitro, chosen before 1.7.2 (500) or as the light compression of 1.7.2.
  if (value === 500 || value === 'light') return 'intact';
  return DISCORD_CHOICES.some((choice) => choice.value === value) ? value : 'intact';
};

export function openDialog(...children) {
  const dialog = h('dialog', {}, ...children);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function dialogHead({ title, symbol, tint = 'accent' }) {
  return h('header', { class: 'dialog-head', style: { '--tint': `var(--${tint})` } },
    h('span', { class: 'badge-icon' }, icon(symbol)),
    h('h2', {}, title));
}

/** With `confirmFirst`, Enter confirms at once. */
export function confirmAction({ title, text, action, symbol = 'trash', danger = true, confirmFirst = false }) {
  return new Promise((resolve) => {
    let result = false;
    const dialog = openDialog(
      dialogHead({ title, symbol, tint: danger ? 'low' : 'accent' }),
      h('p', {}, text),
      h('div', { class: 'dialog-actions' },
        button({ label: t('common.cancel'), autofocus: !confirmFirst, onClick: () => dialog.close() }),
        button({
          label: action,
          autofocus: confirmFirst,
          class: danger ? 'danger solid' : 'primary',
          onClick: () => {
            result = true;
            dialog.close();
          },
        })),
    );
    dialog.addEventListener('close', () => resolve(result));
  });
}

export function askText({ title, text, value = '', suggestions = [], action = t('common.ok'), symbol = 'pencil', maxLength }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'field', value, spellcheck: 'false', maxlength: maxLength, onInput: () => filter() });
    const submit = () => {
      result = input.value;
      dialog.close();
    };
    // In place of a datalist, whose list Windows draws in its own style.
    const known = suggestions.map((name) => h('button', {
      type: 'button',
      class: `tag ${name === value ? 'active' : ''}`,
      onClick: () => {
        input.value = name;
        submit();
      },
    }, name));
    const filter = () => {
      const typed = input.value.trim().toLowerCase();
      suggestions.forEach((name, i) => {
        known[i].hidden = typed !== value.toLowerCase() && !name.toLowerCase().includes(typed);
      });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Closing restores focus to the opener, which this Enter would otherwise click.
      event.preventDefault();
      event.stopPropagation();
      submit();
    });
    const dialog = openDialog(
      dialogHead({ title, symbol }),
      text && h('p', {}, text),
      input,
      known.length > 0 && h('div', { class: 'suggestions' }, known),
      h('div', { class: 'dialog-actions' },
        button({ label: t('common.cancel'), onClick: () => dialog.close() }),
        button({ label: action, class: 'primary', onClick: submit })),
    );
    input.select();
    dialog.addEventListener('close', () => resolve(result));
  });
}

/** Shows what the first sorting of a folder moves. Resolves to true when the user goes ahead. */
async function confirmSorting(root, logos) {
  const { ok, value: plan } = await call('sortPreview', root);
  if (!ok) return false;
  const notes = [
    plan.placed > 0 && t('sort.placed', { count: plan.placed }),
    plan.busy > 0 && t('sort.busy', { count: plan.busy }),
  ].filter(Boolean);
  return new Promise((resolve) => {
    let result = false;
    const dialog = openDialog(
      dialogHead({ title: t('sort.title'), symbol: 'folder' }),
      h('p', {}, plan.moving
        ? t('sort.moving', { count: plan.moving, root })
        : t('sort.nothing', { root })),
      plan.games.length > 0 && h('div', { class: 'sort-plan' }, plan.games.map((row) => h('div', { class: 'sort-row' },
        gameBadge(row.game, logos),
        h('span', { class: 'sort-game ellipsis', title: row.dir }, row.game, h('small', {}, row.dir)),
        h('span', { class: 'storage-size' }, `${t('lib.clipCount', { count: row.count })} · ${format.bytes(row.size)}`)))),
      ...notes.map((note) => h('p', { class: 'hint' }, note)),
      h('p', { class: 'hint' }, t('sort.after')),
      h('div', { class: 'dialog-actions' },
        button({ label: t('common.cancel'), autofocus: true, onClick: () => dialog.close() }),
        button({
          label: plan.moving ? t('sort.go', { count: plan.moving }) : t('common.turnOn'),
          class: 'primary',
          onClick: () => {
            result = true;
            dialog.close();
          },
        })),
    );
    dialog.classList.add('sorting');
    dialog.addEventListener('close', () => resolve(result));
  });
}

async function turnSorting(app, folder, box) {
  box.disabled = true;
  try {
    if (!box.checked) {
      if ((await call('setSorting', folder.path, false)).ok) toast(t('sort.off'));
      return;
    }
    if (!(await confirmSorting(folder.path, app.state.logos))) {
      box.checked = false;
      return;
    }
    const { ok, value } = await call('setSorting', folder.path, true);
    if (!ok) {
      box.checked = false;
      return;
    }
    const failed = value.failed.length;
    toast(`${t('sort.moved', { count: value.moved })}${failed ? ` ${t('sort.busyRetry', { count: failed })}` : ''}`,
      failed ? 'error' : '');
  } finally {
    box.disabled = false;
  }
}

export function openSettings(app) {
  const folders = h('div');
  const folderNote = h('p', { class: 'folder-note', hidden: true });
  const exportPath = h('span');
  const detection = h('input', {
    type: 'checkbox',
    checked: Boolean(app.state.detection?.on),
    onChange: (event) => call('setDetection', event.currentTarget.checked),
  });

  const themes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': t('settings.theme') });
  const renderThemes = () => themes.replaceChildren(...THEMES.map((theme) => {
    const on = (app.state.theme || 'periph') === theme.id;
    const { bg, surface, accent, text } = theme.colors;
    return h('button', {
      class: `theme ${on ? 'active' : ''}`,
      role: 'radio',
      'aria-checked': String(on),
      title: theme.detail || theme.name,
      onClick: () => call('setTheme', theme.id),
    },
    h('span', { class: 'theme-preview', style: { '--a': bg, '--b': surface, '--c': accent, '--d': text } },
      h('i'), h('i'), h('i')),
    h('span', {}, theme.name));
  }));

  const render = () => {
    renderThemes();
    folders.replaceChildren(...app.state.folders.map((folder) => {
      const box = h('input', {
        type: 'checkbox',
        checked: Boolean(folder.sorted),
        disabled: !folder.online,
        'aria-label': t('sort.in', { path: folder.path }),
        onChange: () => turnSorting(app, folder, box),
      });
      return h('div', {
        class: `folder-row ${folder.online ? '' : 'offline'}`,
        'data-folder': folder.path,
      },
      h('span', {}, folder.online ? folder.path : t('settings.offline', { path: folder.path })),
      h('label', { class: 'switch folder-sort', title: t('settings.sortTitle') },
        h('small', {}, t('sort.title')), box),
      button({
        icon: 'close',
        title: t('settings.removeFolder'),
        class: 'ghost',
        onClick: () => call('removeFolder', folder.path),
      }));
    }));
    exportPath.textContent = app.state.exportDir;
  };

  const dialog = openDialog(
    dialogHead({ title: t('settings.title'), symbol: 'gear' }),
    h('h3', {}, t('settings.language')),
    dropdown({
      class: 'language',
      title: t('settings.language'),
      value: language,
      options: LANGUAGES.map(({ id, name }) => ({ value: id, label: name })),
      // The main process opens the window again in that language.
      onChange: (id) => call('setLanguage', id),
    }),
    h('h3', {}, t('settings.folders')),
    folders,
    button({
      icon: 'plus',
      label: t('settings.addFolder'),
      onClick: async () => {
        const { ok, value, error } = await call('addFolder');
        if (ok && value === 'canceled') return;
        folderNote.hidden = false; // In the dialog: a toast would sit under it.
        if (!ok) folderNote.textContent = error;
        else if (value === 'known') folderNote.textContent = t('settings.folderKnown');
        else if (value === 'added') folderNote.textContent = t('settings.folderAdded');
      },
    }),
    folderNote,
    h('h3', {}, t('settings.exportDir')),
    h('div', { class: 'folder-row' }, exportPath,
      button({ label: t('common.change'), class: 'ghost', onClick: () => call('setExportDir') })),
    h('h3', {}, 'Discord'),
    h('div', { class: 'stack' }, t('discord.export'), dropdown({
      title: t('settings.discordCompression'),
      value: discordChoice(),
      options: DISCORD_CHOICES,
      onChange: (value) => store('discordLimit', value),
    })),
    h('h3', {}, 'Valorant'),
    h('label', { class: 'switch' },
      h('span', {}, t('settings.detect'),
        h('small', {}, t('settings.detectText'))),
      detection),
    h('h3', {}, t('settings.theme')),
    themes,
    h('h3', {}, t('shortcuts.title')),
    button({ icon: 'keyboard', label: t('settings.showShortcuts'), onClick: () => call('showShortcuts') }),
    h('div', { class: 'dialog-actions' },
      button({ label: t('common.close'), class: 'primary', autofocus: true, onClick: () => dialog.close() })),
  );
  render();
  dialog.addEventListener('close', app.subscribe(render));
}
