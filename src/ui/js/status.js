// The status bar at the bottom of the window: what runs in the background (reading the clips, the
// kills, the job of the moment with its bar), the hint of the editor tool, then the clips shown and
// selected, a downloaded update, and the free space of the disks that hold the clips. Progress only
// moves its bar.
import { h, icon, call, toast } from './dom.js';
import { t, bytes } from './i18n.js';
import { openUpdate } from './update.js';

export function createStatus(app, el) {
  const texts = { hint: '', counts: '' };
  let job = null;
  let shown = '';

  const bar = h('i');
  const percent = h('span', { class: 'status-percent' });
  const cancel = h('button', { class: 'status-link', onClick: () => call('cancelExport') }, t('common.cancel'));

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
      update && h('span', { class: 'status-item status-update' },
        h('button', { class: 'status-open', title: t('update.openTitle'), onClick: () => openUpdate(app) }, icon('refresh'), t('update.ready', { version: update })),
        h('button', { class: 'status-link', title: t('update.restartTitle'), onClick: restart }, t('update.restart'))),
      texts.counts && h('span', { class: 'status-item' }, texts.counts),
      ...disks.map((disk) => h('span', { class: `status-item ${disk.low ? 'low' : ''}`, title: disk.root },
        icon('drive'), t('status.free', { drive: disk.root.replace(/\\$/, ''), size: bytes(disk.free) }))),
    ].filter(Boolean));
    progress(job?.value || 0);
  }

  /** The downloaded version goes in now; otherwise it would wait for the app to be closed. */
  async function restart() {
    const { ok, error } = await call('installUpdate');
    if (!ok) toast(error, 'error');
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
