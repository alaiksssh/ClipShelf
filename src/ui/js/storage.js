// Where the disk space goes, and compressing clips to H.265 to get some of it back.
import { h, icon, button, call } from './dom.js';
import { openDialog, dialogHead } from './dialogs.js';
import { gameBadge } from './gameBadge.js';
import * as format from './format.js';
import { AGES, byGame, compressible, estimateAfter, olderThan } from '/shared/storage.mjs';
import { openDuplicates } from './duplicates.js';
import { t } from './i18n.js';

let report = null;
window.bridge.onProgress((value, phase) => report?.(value, phase));

const meter = (part, whole) => h('span', { class: 'meter' },
  h('span', { style: { width: `${Math.min(100, (part / Math.max(1, whole)) * 100).toFixed(1)}%` } }));

/** With `ids`, those clips are ticked, for "Compresser" from the menu of a clip. */
export async function openStorage(app, ids = []) {
  const { clips, logos } = app.state;
  const { value: info } = await call('storage');
  const total = clips.reduce((sum, clip) => sum + clip.size, 0);

  const disks = h('section', { class: 'storage-block' },
    h('h3', {}, t('storage.disks')),
    ...(info?.disks || []).map((disk) => h('div', { class: 'storage-row' },
      h('span', { class: 'storage-name' }, icon('drive'), disk.root.replace(/\\$/, '')),
      meter(disk.total - disk.free, disk.total),
      h('span', { class: 'storage-size' }, t('storage.free', { free: format.bytes(disk.free), total: format.bytes(disk.total) })))));

  const games = h('section', { class: 'storage-block' },
    h('h3', {}, t('storage.yours', { size: format.bytes(total), count: clips.length })),
    ...byGame(clips).map((row) => h('div', { class: 'storage-row' },
      h('span', { class: 'storage-name' },
        row.game ? gameBadge(row.game, logos) : h('span', { class: 'badge-icon' }, icon('stack')),
        h('span', { class: 'ellipsis' }, row.game ?? t('storage.otherGames', { count: row.games }))),
      meter(row.size, total),
      h('span', { class: 'storage-size' }, `${format.bytes(row.size)} · ${row.count}`))));

  // Replays that hold the same moments twice: their own dialog.
  const repeated = app.state.duplicates?.groups || [];
  const duplicates = repeated.length > 0 && h('section', { class: 'storage-block' },
    h('h3', {}, t('dup.title')),
    h('div', { class: 'notice' },
      icon('duplicate'),
      h('span', {}, t('dup.storageText', {
        count: repeated.length,
        saved: format.bytes(repeated.reduce((sum, group) => sum + group.saved, 0)),
      })),
      button({
        label: t('dup.see'),
        class: 'ghost small see-duplicates',
        onClick: () => {
          dialog.close();
          openDuplicates(app);
        },
      })));

  // Compressing
  const candidates = clips.filter(compressible).sort((a, b) => b.size - a.size);
  const ticked = new Set(ids.filter((id) => candidates.some((clip) => clip.id === id)));
  let age = AGES[0];
  const list = h('div', { class: 'storage-list' });
  const summary = h('span', { class: 'storage-summary' });
  const ages = h('div', { class: 'storage-ages' });
  const all = button({ label: t('storage.tickAll'), class: 'ghost small' });
  const start = button({ icon: 'compress', label: t('storage.compress'), class: 'primary' });

  const shown = () => candidates.filter((clip) => olderThan(clip, age.days));
  const render = () => {
    ages.replaceChildren(...AGES.map((item) => h('button', {
      type: 'button',
      class: `tag ${item === age ? 'active' : ''}`,
      onClick: () => {
        age = item;
        render();
      },
    }, t(`age.${item.id}`))));
    const visible = shown();
    for (const id of ticked) if (!visible.some((clip) => clip.id === id)) ticked.delete(id);
    list.replaceChildren(...visible.map((clip) => {
      const box = h('input', {
        type: 'checkbox',
        checked: ticked.has(clip.id),
        onChange: () => {
          if (box.checked) ticked.add(clip.id);
          else ticked.delete(clip.id);
          update();
        },
      });
      return h('label', { class: 'storage-clip', 'data-id': clip.id },
        box,
        gameBadge(clip.game, logos),
        h('span', { class: 'ellipsis' }, format.title(clip)),
        h('span', { class: 'storage-date' }, format.when(clip.date)),
        h('span', { class: 'storage-size' }, `${format.bytes(clip.size)} → ≈ ${format.bytes(estimateAfter(clip))}`));
    }));
    if (!visible.length) {
      list.append(h('p', { class: 'hint' }, candidates.length
        ? t('storage.noneThatOld')
        : t('storage.allDone')));
    }
    update();
  };
  const update = () => {
    const chosen = candidates.filter((clip) => ticked.has(clip.id));
    const saved = chosen.reduce((sum, clip) => sum + clip.size - estimateAfter(clip), 0);
    summary.textContent = chosen.length
      ? t('storage.ticked', { count: chosen.length, saved: format.bytes(saved) })
      : t('storage.tickSome');
    start.disabled = !chosen.length;
    const visible = shown();
    all.hidden = !visible.length;
    all.lastChild.textContent = visible.every((clip) => ticked.has(clip.id)) ? t('storage.untickAll') : t('storage.tickAll');
  };
  all.addEventListener('click', () => {
    const visible = shown();
    const every = visible.every((clip) => ticked.has(clip.id));
    for (const clip of visible) {
      if (every) ticked.delete(clip.id);
      else ticked.add(clip.id);
    }
    render();
  });

  const compressing = h('section', { class: 'storage-block' },
    h('h3', {}, t('storage.compressTitle')),
    h('p', {}, t('storage.compressText')),
    info?.obs && h('div', { class: 'notice warn' },
      icon('gauge'),
      h('span', {}, h('b', {}, t('storage.obsOpen')),
        t('storage.obsText'))),
    h('div', { class: 'storage-tools' }, ages, all),
    list,
    h('small', { class: 'hint' }, t('storage.hevcHint')));

  const body = h('div', { class: 'storage-body' }, disks, games, duplicates, compressing);
  const actions = h('div', { class: 'dialog-actions' },
    summary,
    button({ label: t('common.close'), onClick: () => dialog.close() }),
    start);
  const dialog = openDialog(dialogHead({ title: t('storage.title'), symbol: 'drive' }), body, actions);
  dialog.classList.add('storage');
  render();
  list.querySelector(`[data-id="${[...ticked][0]}"]`)?.scrollIntoView({ block: 'nearest' });

  let running = false;
  dialog.addEventListener('cancel', (event) => {
    if (running) event.preventDefault();
  });

  start.addEventListener('click', async () => {
    const chosen = candidates.filter((clip) => ticked.has(clip.id));
    running = true;
    const bar = h('progress', { max: 1, value: 0 });
    const status = h('p', {}, t('storage.preparing'));
    report = (value, phase) => {
      bar.value = value;
      const i = Math.min(chosen.length - 1, Math.floor(value * chosen.length));
      const step = phase === 'check' ? t('storage.checking') : t('common.percent', { n: Math.round(value * 100) });
      status.textContent = t('storage.progress', { n: i + 1, count: chosen.length, name: format.title(chosen[i]), step });
    };
    body.replaceChildren(h('section', { class: 'storage-block' }, h('h3', {}, t('discord.compression')), status, bar));
    actions.replaceChildren(button({ label: t('storage.stop'), onClick: () => call('cancelExport') }));

    const { ok, value } = await call('compress', chosen.map((clip) => clip.id));
    running = false;
    report = null;
    actions.replaceChildren(button({ label: t('common.close'), class: 'primary', autofocus: true, onClick: () => dialog.close() }));
    if (!ok) {
      body.replaceChildren(h('p', {}, t('storage.notStarted')));
      return;
    }
    body.replaceChildren(results(value));
  });
}

function results({ done = [], skipped = [], canceled = false }) {
  const before = done.reduce((sum, item) => sum + item.before, 0);
  const after = done.reduce((sum, item) => sum + item.after, 0);
  const left = done.filter((item) => !item.trashed);
  return h('section', { class: 'storage-block' },
    h('h3', {}, canceled ? t('storage.stopped') : t('storage.finished')),
    done.length
      ? h('p', {}, t('storage.result', { count: done.length, before: format.bytes(before), after: format.bytes(after), saved: format.bytes(before - after) }))
      : h('p', {}, t('storage.none')),
    done.length > left.length && h('div', { class: 'notice' },
      icon('trash'),
      h('span', {}, h('b', {}, t('storage.binned')), t('storage.binnedText'))),
    left.length > 0 && h('div', { class: 'notice warn' },
      icon('trash'),
      h('span', {}, h('b', {}, t('storage.aside')), left.map((item) => item.aside).join('\n'))),
    skipped.length > 0 && h('div', { class: 'storage-skipped' },
      h('b', {}, t('storage.kept')),
      ...skipped.map((item) => h('div', {}, h('span', { class: 'ellipsis' }, item.name), h('small', {}, item.reason)))));
}
