// "A new version is ready": the same kind of window as "what's new", once per session when an update
// has been downloaded, and again from the status bar. Closed, the update waits there at the bottom
// right, and goes in by itself when ClipShelf is closed.
import { h, icon, button, call, toast } from './dom.js';
import { t, language } from './i18n.js';
import { openDialog, dialogHead } from './dialogs.js';
import { notesFor } from '/shared/releaseNotes.mjs';

// While the user is busy elsewhere (a dialog, the clip alone over the screen), it waits that long
// before trying again.
const RETRY = 3000;

let announced = null;
let retry = null;

/** The window of the downloaded version. */
export function openUpdate(app) {
  const { update: version, updateNotes } = app.state;
  if (!version) return;
  const news = notesFor(updateNotes, language);
  const dialog = openDialog(
    dialogHead({ title: t('update.title', { version }), symbol: 'refresh' }),
    news.length
      ? h('ul', { class: 'news' }, ...news.map((text) => h('li', {}, icon('tick'), h('span', {}, text))))
      : h('p', {}, t('update.noNotes')),
    h('p', { class: 'update-later' }, t('update.later')),
    h('div', { class: 'dialog-actions' },
      button({ label: t('update.notNow'), class: 'ghost', onClick: () => dialog.close() }),
      button({
        label: t('update.restartNow'),
        icon: 'refresh',
        class: 'primary',
        autofocus: true,
        onClick: async () => {
          // A refusal with a reason (an export running) is shown by call() itself.
          const { ok, value } = await call('installUpdate');
          if (ok && value === false) toast(t('update.notReady'), 'error');
          else if (ok) dialog.close();
        },
      })),
  );
  dialog.classList.add('news-dialog', 'update-dialog');
}

/** Called at each change of the state: a newly downloaded version is announced once. */
export function announceUpdate(app) {
  const version = app.state.update;
  if (!version || version === announced) return;
  clearTimeout(retry);
  if (document.querySelector('dialog[open], .menu') || app.editor?.videoOnly) {
    retry = setTimeout(() => announceUpdate(app), RETRY);
    return;
  }
  announced = version;
  openUpdate(app);
}
