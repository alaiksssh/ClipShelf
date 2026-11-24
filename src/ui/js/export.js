import { h, icon, button, call, remember, store } from './dom.js';
import { openDialog, dialogHead, discordChoice, discordLimitOf, DISCORD_CHOICES } from './dialogs.js';
import { dropdown } from './menu.js';
import * as format from './format.js';
import { VIDEO, totalLength } from '/shared/pieces.mjs';
import { audibleTracks, canCopyVideo, createEdit, loadEdit, outputEdit } from '/shared/edit.mjs';
import { t } from './i18n.js';

let reportProgress = null;
window.bridge.onProgress((value, phase) => reportProgress?.(value, phase));
let reportLog = null;
window.bridge.onJobLog((text, live) => reportLog?.(text, live));

/**
 * The steps of an export, under the bar: one line per step, with the time since the start. The main
 * process updates the line of the running step as ffmpeg goes. It stays after the end, to tell what
 * the export did.
 */
function jobLog() {
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const list = h('ol', { class: 'job-log' });
  const add = (text, live = false) => {
    const last = list.lastElementChild;
    if (live && last) last.lastElementChild.textContent = text;
    else list.append(h('li', {}, h('time', {}, format.duration(elapsed())), h('span', {}, text)));
    list.scrollTop = list.scrollHeight;
  };
  reportLog = add;
  return {
    list,
    end: (ok) => {
      reportLog = null;
      add(t(ok ? 'log.done' : 'log.failed', { time: format.seconds(elapsed()) }));
    },
  };
}

const SIZES = [10, 25, 50, 100, 500];

export function openExport(clip, edit, analysis) {
  const audible = audibleTracks(edit.tracks);
  const count = audible.filter(Boolean).length;
  // What is heard in the preview is what gets exported.
  const pieces = edit.pieces.filter((piece) => piece.lane === VIDEO || (audible[piece.lane] && !piece.muted));
  const length = totalLength(pieces);
  const canCopy = canCopyVideo({ ...edit, pieces });

  let mode = remember('exportMode', 'quality');
  if (mode === 'copy' && !canCopy) mode = 'quality';

  const size = dropdown({
    title: t('export.maxSize'),
    value: remember('exportSize', 10),
    options: SIZES.map((value) => ({ value, label: t('unit.mb', { n: value }), detail: value === 10 ? t('export.discordNoNitro') : '' })),
  });
  const sizeRow = h('div', { class: 'stack', hidden: mode !== 'size' }, t('export.maxSize'), size);

  const choice = ({ id, symbol, color, name, text, enabled = true }) => h('label', {
    class: 'choice',
    style: { '--tint': `var(--${color})` },
  },
  h('input', {
    type: 'radio',
    name: 'mode',
    checked: mode === id,
    disabled: !enabled,
    onChange: () => {
      mode = id;
      sizeRow.hidden = id !== 'size';
    },
  }),
  icon(symbol),
  h('span', {}, h('b', {}, name), h('small', {}, text)));

  const separate = h('input', { type: 'checkbox' });
  const body = h('div', {},
    choice({
      id: 'quality', symbol: 'film', color: 'gpu', name: t('export.quality'),
      text: t('export.qualityText'),
    }),
    choice({
      id: 'size', symbol: 'size', color: 'cpu', name: t('export.size'),
      text: t('export.sizeText'),
    }),
    choice({
      id: 'copy', symbol: 'gauge', color: 'net', name: t('export.copy'), enabled: canCopy,
      text: canCopy
        ? t('export.copyText')
        : t('export.copyOff'),
    }),
    sizeRow,
    count > 1 && h('label', { class: 'switch' }, t('export.separate'), separate));

  const actions = h('div', { class: 'dialog-actions' });
  const dialog = openDialog(
    dialogHead({ title: t('export.title'), symbol: 'output' }),
    h('p', {}, t('export.summary', {
      length: format.duration(length, 1),
      sound: count ? t('export.tracks', { count }) : t('export.silent'),
    })),
    body,
    actions,
  );

  let running = false;
  // Escape must not hide a running export.
  dialog.addEventListener('cancel', (event) => {
    if (running) event.preventDefault();
  });

  const start = async () => {
    running = true;
    store('exportMode', mode);
    store('exportSize', size.value);

    const bar = h('progress', { max: 1, value: 0 });
    const status = h('p', {}, t('export.running'));
    reportProgress = (value) => {
      bar.value = value;
      status.textContent = t('export.progress', { percent: Math.round(value * 100) });
    };
    const log = jobLog();
    body.replaceChildren(status, bar, log.list);
    actions.replaceChildren(button({ label: t('export.cancel'), onClick: () => call('cancelExport') }));

    const { ok, value, error } = await call('export', clip.id, {
      mode,
      targetMB: size.value,
      separate: separate.checked,
      edit,
      labels: analysis?.tracks.map((track) => track.label),
    });
    running = false;
    reportProgress = null;
    log.end(ok);

    if (ok && value.canceled) {
      dialog.close();
      return;
    }
    const close = button({ label: t('common.close'), onClick: () => dialog.close() });
    if (!ok) {
      body.replaceChildren(h('p', {}, error), log.list);
      actions.replaceChildren(close);
      return;
    }
    body.replaceChildren(h('p', {}, t('export.done', { size: format.bytes(value.size), path: value.path })), log.list);
    actions.replaceChildren(close, button({
      icon: 'folder',
      label: t('export.reveal'),
      class: 'primary',
      onClick: () => call('revealExport', value.path),
    }));
  };

  actions.append(
    button({ label: t('common.cancel'), onClick: () => dialog.close() }),
    button({ icon: 'output', label: t('export.title'), class: 'primary', onClick: start }),
  );
}

/**
 * Exports for Discord and copies the file, ready for Ctrl+V. The compression is chosen first, and
 * nothing starts before "Exporter". `edit` is what the editor shows; from the library it is the saved
 * montage, or the clip with the tracks the editor would turn on.
 */
export function openDiscord(clip, edit = null) {
  // The sound is analysed while the compression is chosen. Without it, only the first track would be
  // on; with it, silent and repeated tracks stay off.
  const ready = edit ? Promise.resolve(edit)
    : clip.edit ? Promise.resolve(outputEdit(loadEdit(clip.edit, clip)))
      : call('analysis', clip.id).then((answer) => outputEdit(createEdit(clip, answer.ok ? answer.value : null)));

  let exporting = false;
  const status = h('p', { hidden: true });
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const logSlot = h('div', {});
  const result = h('div', {});
  const actions = h('div', { class: 'dialog-actions' });
  const cancel = button({
    label: t('common.cancel'),
    onClick: () => (exporting ? call('cancelExport') : dialog.close()),
  });
  const go = button({ icon: 'output', label: t('export.title'), class: 'primary', onClick: () => start() });
  const picker = dropdown({
    title: t('settings.discordCompression'),
    value: discordChoice(),
    options: DISCORD_CHOICES,
    onChange: () => {
      // After an export, another choice is exported only when asked.
      result.replaceChildren();
      logSlot.replaceChildren();
      actions.replaceChildren(cancel, go);
    },
  });
  const body = h('div', {}, h('div', { class: 'stack' }, t('discord.compression'), picker), status, bar, logSlot, result);
  const dialog = openDialog(dialogHead({ title: t('discord.export'), symbol: 'discord' }), body, actions);
  dialog.addEventListener('cancel', (event) => {
    if (exporting) event.preventDefault();
  });
  actions.append(cancel, go);
  go.focus();

  async function start() {
    picker.disabled = true;
    result.replaceChildren();
    actions.replaceChildren(cancel);
    status.hidden = false;
    bar.hidden = false;
    bar.value = 0;
    status.textContent = t('discord.analysing');
    const montage = await ready;
    if (!dialog.open) return; // Cancelled during the analysis.

    const choice = picker.value;
    // The choice used last comes back next time; one only looked at in the list does not.
    store('discordLimit', choice);
    const describe = t('discord.describe', { what: choice === 'intact' ? t('discord.intactLower') : t('discord.atMost', { n: choice }) });
    status.textContent = t('discord.progress', { percent: 0, describe });
    reportProgress = (value) => {
      bar.value = value;
      status.textContent = t('discord.progress', { percent: Math.round(value * 100), describe });
    };
    const log = jobLog();
    logSlot.replaceChildren(log.list);
    exporting = true;
    const { ok, value, error } = await call('discord', clip.id, { edit: montage, targetMB: discordLimitOf(choice) });
    exporting = false;
    reportProgress = null;
    log.end(ok);
    picker.disabled = false;
    if (ok && value.canceled) {
      dialog.close();
      return;
    }

    status.hidden = true;
    bar.hidden = true;
    const close = button({ label: t('common.close'), class: 'primary', onClick: () => dialog.close() });
    if (!ok) {
      result.replaceChildren(h('p', {}, error));
      actions.replaceChildren(close);
      return;
    }
    result.replaceChildren(
      value.copied
        ? h('div', { class: 'notice' }, icon('paste'),
          h('span', {}, h('b', {}, t('discord.copied')), t('discord.paste')))
        : h('div', { class: 'notice warn' }, icon('paste'),
          h('span', {}, h('b', {}, t('discord.notCopied')), t('discord.drag'))),
      h('p', {}, value.copied
        ? t('discord.temporary', { size: format.bytes(value.size) })
        : t('discord.file', { size: format.bytes(value.size), path: value.path })),
    );
    actions.replaceChildren(...(value.copied ? [] : [button({
      icon: 'folder',
      label: t('export.reveal'),
      onClick: () => call('revealExport', value.path),
    })]), close);
    close.focus();
  }
}

/** Saves the montage over its clip. `onRunning` tells when the file is being replaced. */
export function openOverwrite(clip, edit, analysis, { onRunning, onSaved }) {
  const audible = audibleTracks(edit.tracks);
  const count = audible.filter(Boolean).length;
  const nameOf = (i) => edit.tracks[i].name || analysis?.tracks[i]?.label || t('track.n', { n: i + 1 });
  const dropped = edit.tracks.flatMap((_, i) => (audible[i] ? [] : [nameOf(i)]));
  const length = totalLength(edit.pieces.filter((piece) => piece.lane === VIDEO || (audible[piece.lane] && !piece.muted)));

  const separate = h('input', { type: 'checkbox', checked: count > 1 });
  const body = h('div', {},
    h('p', {}, t('overwrite.text', { length: format.duration(length, 1) })),
    dropped.length > 0 && h('div', { class: 'notice warn' },
      icon('muted'),
      h('span', {}, h('b', {}, t('overwrite.dropped')), dropped.join(', '))),
    h('div', { class: 'notice warn' },
      icon('trash'),
      h('span', {}, h('b', {}, t('overwrite.final')),
        t('overwrite.finalText', { size: format.bytes(clip.size) }))),
    count > 1 && h('label', { class: 'switch' },
      h('span', {}, t('overwrite.separate'),
        h('small', {}, t('overwrite.separateText'))),
      separate));

  const actions = h('div', { class: 'dialog-actions' });
  const dialog = openDialog(dialogHead({ title: t('overwrite.title'), symbol: 'save' }), body, actions);

  let running = false;
  dialog.addEventListener('cancel', (event) => {
    if (running) event.preventDefault();
  });

  const start = async () => {
    running = true;
    onRunning(true);
    const bar = h('progress', { max: 1, value: 0 });
    const status = h('p', {}, t('overwrite.saving'));
    reportProgress = (value, phase) => {
      bar.value = value;
      const percent = t('common.percent', { n: Math.round(value * 100) });
      if (phase === 'source') status.textContent = t('overwrite.checkSource', { percent });
      else if (phase === 'check') {
        status.textContent = value < 1 ? t('overwrite.checkNew', { percent }) : t('overwrite.replacing');
      } else status.textContent = value < 1 ? t('overwrite.progress', { percent }) : t('overwrite.checking');
    };
    const request = { separate: separate.checked, edit, labels: analysis?.tracks.map((track) => track.label) };
    body.replaceChildren(status, bar);
    actions.replaceChildren(button({ label: t('common.cancel'), onClick: () => call('cancelExport') }));

    const { ok, value, error } = await call('overwrite', clip.id, request);
    running = false;
    reportProgress = null;
    onRunning(false);
    if (!ok) {
      body.replaceChildren(h('p', {}, error));
      actions.replaceChildren(button({ label: t('common.close'), onClick: () => dialog.close() }));
      return;
    }
    dialog.close();
    if (!value.canceled) await onSaved(value);
  };

  actions.append(
    button({ label: t('common.cancel'), autofocus: true, onClick: () => dialog.close() }),
    button({ icon: 'save', label: t('overwrite.go'), class: 'danger solid', onClick: start }),
  );
}
