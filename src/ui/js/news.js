// "What's new", once after an update. Each version lists its news here; a version without any
// shows nothing and is marked as seen.
import { h, icon, button, call } from './dom.js';
import { t } from './i18n.js';
import { openDialog, dialogHead } from './dialogs.js';

const NEWS = {
  '1.13.0': [
    { key: 'news.pieceVolume', symbol: 'volume' },
    { key: 'news.rangeVolume', symbol: 'range' },
    { key: 'news.editorFixes', symbol: 'check' },
    { key: 'news.updates', symbol: 'refresh' },
  ],
  '1.12.0': [
    { key: 'news.palette', symbol: 'search' },
    { key: 'news.list', symbol: 'list' },
    { key: 'news.info', symbol: 'info' },
    { key: 'news.status', symbol: 'gauge' },
    { key: 'news.tips', symbol: 'keyboard' },
    { key: 'news.window', symbol: 'fit' },
  ],
};

export function openNews(version) {
  const items = NEWS[version];
  if (!items) {
    call('newsSeen');
    return;
  }
  const dialog = openDialog(
    dialogHead({ title: t('news.title', { version }), symbol: 'tick' }),
    h('ul', { class: 'news' }, ...items.map(({ key, symbol }) => h('li', {}, icon(symbol), h('span', {}, t(key))))),
    h('div', { class: 'dialog-actions' },
      button({ label: t('news.ok'), class: 'primary', autofocus: true, onClick: () => dialog.close() })),
  );
  dialog.classList.add('news-dialog');
  dialog.addEventListener('close', () => call('newsSeen'));
}
