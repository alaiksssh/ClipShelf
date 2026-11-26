// The status bar at the bottom of the window: what runs in the background (reading the clips, the
// kills, the job of the moment with its bar), the hint of the editor tool, then the clips shown and
// selected, an update (its download, then a link to install it), and the free space of the disks that hold the clips. Progress only
// moves its bar.
import { h, icon, call } from './dom.js';
import { t, bytes } from './i18n.js';
import { openUpdate, installFromStatus, onUpdateShare, updateShare } from './update.js';

export function createStatus(app, el) {
  const texts = { hint: '', counts: '' };
  let job = null;
  let shown = '';

  const bar = h('i');
  const percent = h('span', { class: 'status-percent' });
  const cancel = h('button', { class: 'status-link', onClick: () => call('cancelExport') }, t('common.cancel'));

  const updateBar = h('i');
  const updatePercent = h('span', { class: 'status-percent' });
  const showUpdateShare = (share) => {
    updateBar.style.width = `${Math.round(share * 100)}%`;
    updatePercent.textContent = t('common.percent', { n: Math.round(share * 100) });
  };
  onUpdateShare(showUpdateShare);

  const busy = (text) => h('span', { class: 'status-item' }, h('i', { class: 'status-spin', 'aria-hidden': 'true' }), text);

  function render() {
    const { scanned, detection, disks = [], update } = app.state;
    const key = JSON.stringify([scanned, detection?.left, disks, job?.label, texts, update]);
    if (key === shown) return;
    shown = key;
    el.replaceChildren(...[
      !scanned && busy(t('lib.reading')),
      detection?.left > 0 && busy(t('lib.analysing', { count: detection.left })),
      job && h('span', { class: 'status-item status-job' },
        h('span', { class: 'status-name' }, job.label), h('span', { class: 'status-bar' }, bar), percent, cancel),
      texts.hint && h('span', { class: 'status-item status-hint' }, texts.hint),
      h('span', { class: 'grow' }),
      update?.ready && h('span', { class: 'status-item status-update' },
        h('button', { class: 'status-open', title: t('update.openTitle'), onClick: () => openUpdate(app) }, icon('refresh'), t('update.ready', { version: update.version })),
        h('button', { class: 'status-link', title: t('update.restartTitle'), onClick: restart }, t('update.restart'))),
      update && !update.ready && !update.failed && h('span', { class: 'status-item status-update' },
        h('button', { class: 'status-open', title: t('update.openTitle'), onClick: () => openUpdate(app) },
          icon('refresh'), t(update.waiting ? 'update.statusWaiting' : 'update.statusDownloading', { version: update.version })),
        h('span', { class: 'status-bar' }, updateBar), updatePercent),
      texts.counts && h('span', { class: 'status-item' }, texts.counts),
      ...disks.map((disk) => h('span', { class: `status-item ${disk.low ? 'low' : ''}`, title: disk.root },
        icon('drive'), t('status.free', { drive: disk.root.replace(/\\$/, ''), size: bytes(disk.free) }))),
    ].filter(Boolean));
    progress(job?.value || 0);
    if (update && !update.ready) showUpdateShare(updateShare(update));
  }

  /** The downloaded version goes in now; otherwise it would wait for the app to be closed. */
  async function restart() {
    await installFromStatus();
  }

  function progress(value) {
    bar.style.width = `${Math.round(value * 100)}%`;
    percent.textContent = t('common.percent', { n: Math.round(value * 100) });
  }

  window.bridge.onJob((value) => {
    job = value && { label: value.label || t('status.working'), value: 0 };
    render();
  });
  window.bridge.onProgress((value) => {
    if (!job) return;
    job.value = Math.min(1, Math.max(0, value));
    progress(job.value);
  });
  app.subscribe(render);
  render();

  return {
    /** `hint` (the editor tool) or `counts` (clips shown and selected). */
    set(name, text) {
      if (texts[name] === text) return;
      texts[name] = text;
      render();
    },
  };
}
