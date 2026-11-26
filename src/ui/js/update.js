// "A new version is available": the same kind of window as "what's new", once per session as soon as
// a newer version is found, and again from the status bar. While it downloads, a bar shows how far it
// is; "Installer et redémarrer" then waits for the end, and ClipShelf closes by itself to install it.
// Closed, the update waits at the bottom right, and goes in by itself when ClipShelf is closed.
import { h, icon, button, call, toast } from './dom.js';
import { t, language } from './i18n.js';
import { openDialog, dialogHead } from './dialogs.js';
import { notesFor } from '/shared/releaseNotes.mjs';

// While the user is busy elsewhere (a dialog, the clip alone over the screen), it waits that long
// before trying again.
const RETRY = 3000;

let announced = null;
let retry = null;
let refreshOpen = null; // Redraws the open window when the state of the update changes.

// The download moves often: its share comes on a channel of its own, not with the whole state.
let liveShare = 0;
const shareListeners = new Set();
window.bridge.onUpdateProgress?.((share) => {
  liveShare = share;
  for (const listener of shareListeners) listener(share);
});

/** Calls `listener` with each new share of the download (0 to 1); returns how to stop. */
export function onUpdateShare(listener) {
  shareListeners.add(listener);
  return () => shareListeners.delete(listener);
}

/** The share of the download known now: the state's, or a newer one from the channel. */
export function updateShare(update) {
  return update.ready ? 1 : Math.max(update.share || 0, liveShare);
}

/** Asks for the install, or with `want` false, no longer waits for the end of the download. */
async function askInstall(want = true) {
  // A refusal with a reason (an export running) is shown by call() itself.
  const { ok, value } = await call('installUpdate', want);
  if (want && ok && value === false) toast(t('update.notReady'), 'error');
  return ok ? value : false;
}

/** The window of the newer version. */
export function openUpdate(app) {
  if (!app.state.update) return;
  document.querySelector('dialog.update-dialog')?.close();
  const head = dialogHead({ title: '', symbol: 'refresh' });
  const title = head.querySelector('h2');
  const news = h('div');
  const progress = h('div', { class: 'update-progress' });
  const note = h('p', { class: 'update-later' });
  const actions = h('div', { class: 'dialog-actions' });
  const dialog = openDialog(head, news, progress, note, actions);
  dialog.classList.add('news-dialog', 'update-dialog');

  const bar = h('progress', { max: 1, value: 0 });
  const percent = h('span', { class: 'update-percent' });
  const showShare = (share) => {
    bar.value = share;
    percent.textContent = t('update.downloading', { n: Math.round(share * 100) });
  };
  const stopShare = onUpdateShare(showShare);

  let shown = '';
  const render = () => {
    const update = app.state.update;
    if (!update) return dialog.close();
    const key = JSON.stringify([update, app.state.updateNotes]);
    if (key === shown) return;
    shown = key;
    const { version, ready, waiting, failed } = update;
    title.textContent = t(ready ? 'update.title' : 'update.available', { version });
    const items = notesFor(app.state.updateNotes, language);
    news.replaceChildren(items.length
      ? h('ul', { class: 'news' }, ...items.map((text) => h('li', {}, icon('tick'), h('span', {}, text))))
      : h('p', {}, t('update.noNotes')));
    progress.hidden = ready || failed;
    progress.replaceChildren(percent, bar);
    showShare(updateShare(update));
    note.classList.toggle('update-failed', failed);
    note.textContent = t(failed ? 'update.failed' : ready ? 'update.later' : waiting ? 'update.waitingNote' : 'update.downloadingNote');
    actions.replaceChildren(
      waiting
        ? button({ label: t('common.cancel'), class: 'ghost', onClick: () => askInstall(false) })
        : button({ label: t('update.notNow'), class: 'ghost', onClick: () => dialog.close() }),
      button({
        label: t(waiting ? 'update.waiting' : 'update.restartNow'),
        icon: 'refresh',
        class: 'primary',
        autofocus: true,
        disabled: waiting || failed,
        onClick: async () => {
          const value = await askInstall();
          // Installing now: ClipShelf is about to close.
          if (value === true) dialog.close();
        },
      }),
    );
  };
  refreshOpen = render;
  dialog.addEventListener('close', () => {
    stopShare();
    if (refreshOpen === render) refreshOpen = null;
  });
  render();
}

/** Called at each change of the state: a newly found version is announced once. */
export function announceUpdate(app) {
  refreshOpen?.();
  const version = app.state.update?.version;
  if (!version || version === announced) return;
  clearTimeout(retry);
  if (document.querySelector('dialog[open], .menu') || app.editor?.videoOnly) {
    retry = setTimeout(() => announceUpdate(app), RETRY);
    return;
  }
  announced = version;
  openUpdate(app);
}

/** From the status bar: installs now, or waits for the end of the download. */
export function installFromStatus() {
  return askInstall();
}
