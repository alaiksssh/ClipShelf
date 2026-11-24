// Replays of the OBS replay buffer that hold the same moments: joining them into one clip, or
// removing what they share. The main process found the groups by their packets.
import { h, icon, button, call, remember, store } from './dom.js';
import { openDialog, dialogHead } from './dialogs.js';
import { gameBadge } from './gameBadge.js';
import * as format from './format.js';
import { t } from './i18n.js';

const MODES = [
  { id: 'join', symbol: 'link', color: 'accent', name: 'dup.join', text: 'dup.joinText', action: 'dup.joinButton' },
  { id: 'trim', symbol: 'scissors', color: 'warn', name: 'dup.trim', text: 'dup.trimText', action: 'dup.trimButton' },
];
const STEPS = { read: 'dup.reading', copy: 'dup.copying', check: 'storage.checking' };

let report = null;
window.bridge.onProgress((value, phase) => report?.(value, phase));

const groupKey = (group) => group.ids.join('|');

/** The clips of a group on one time line: where each one starts and ends among the others. */
function lanes(app, group) {
  const percent = (seconds) => `${((seconds / Math.max(1, group.length)) * 100).toFixed(2)}%`;
  return h('div', { class: 'dup-lanes' }, ...group.clips.map((member) => {
    const clip = app.clip(member.id);
    return h('div', { class: `dup-lane ${member.inside ? 'inside' : ''}` },
      h('span', { class: 'ellipsis', title: clip?.path }, clip ? format.title(clip) : ''),
      h('span', { class: 'dup-track' },
        h('span', { class: 'dup-bar', style: { left: percent(member.start), width: percent(member.end - member.start) } })),
      h('small', {}, member.inside ? t('dup.inside') : format.duration(member.end - member.start)));
  }));
}

/** With `ids`, only the groups of those clips are ticked, for the menu or the badge of a clip. */
export function openDuplicates(app, ids = []) {
  const found = () => app.state.duplicates || { pending: 0, groups: [] };
  const ticked = new Set(found().groups.filter((group) => !ids.length || group.ids.some((id) => ids.includes(id))).map(groupKey));
  let mode = MODES.find((item) => item.id === remember('duplicateMode', 'join')) || MODES[0];

  const list = h('div', { class: 'storage-list dup-list' });
  const waiting = h('p', { class: 'hint' });
  const summary = h('span', { class: 'storage-summary' });
  const start = button({ icon: mode.symbol, label: t(mode.action), class: 'primary' });
  const choices = MODES.map((item) => h('label', { class: 'choice', style: { '--tint': `var(--${item.color})` } },
    h('input', {
      type: 'radio',
      name: 'duplicate-mode',
      checked: item === mode,
      onChange: () => {
        mode = item;
        store('duplicateMode', item.id);
        start.replaceChildren(icon(item.symbol), t(item.action));
      },
    }),
    icon(item.symbol),
    h('span', {}, h('b', {}, t(item.name)), h('small', {}, t(item.text)))));

  const shown = () => found().groups.filter((group) => group.ids.every((id) => app.clip(id)));
  const update = () => {
    const chosen = shown().filter((group) => ticked.has(groupKey(group)));
    const saved = chosen.reduce((sum, group) => sum + group.saved, 0);
    summary.textContent = chosen.length ? t('storage.ticked', { count: chosen.length, saved: format.bytes(saved) }) : t('dup.tickSome');
    start.disabled = !chosen.length;
  };
  const render = () => {
    const groups = shown();
    const { pending } = found();
    list.replaceChildren(...groups.map((group) => {
      const key = groupKey(group);
      const clips = group.ids.map((id) => app.clip(id));
      const box = h('input', {
        type: 'checkbox',
        checked: ticked.has(key),
        onChange: () => {
          if (box.checked) ticked.add(key);
          else ticked.delete(key);
          update();
        },
      });
      return h('label', { class: 'dup-group', 'data-ids': key },
        box,
        gameBadge(clips.at(-1).game, app.state.logos),
        h('span', { class: 'dup-body' },
          h('span', { class: 'dup-head' },
            h('b', {}, format.when(clips.at(-1).date)),
            h('span', { class: 'storage-size' }, t('dup.shared', { time: format.seconds(group.shared), size: format.bytes(group.saved) }))),
          lanes(app, group)));
    }));
    if (!groups.length) list.append(h('p', { class: 'hint' }, pending ? t('dup.pending', { count: pending }) : t('dup.none')));
    waiting.hidden = !pending || !groups.length;
    waiting.textContent = t('dup.pending', { count: pending });
    update();
  };

  const body = h('div', { class: 'storage-body' },
    h('p', {}, t('dup.intro')),
    h('div', { class: 'dup-modes' }, choices),
    waiting,
    list,
    h('small', { class: 'hint' }, t('dup.hint')));
  const actions = h('div', { class: 'dialog-actions' },
    summary,
    button({ label: t('common.close'), onClick: () => dialog.close() }),
    start);
  const dialog = openDialog(dialogHead({ title: t('dup.title'), symbol: 'duplicate' }), body, actions);
  dialog.classList.add('storage', 'duplicates');
  render();
  list.querySelector('input:checked')?.closest('label').scrollIntoView({ block: 'nearest' });

  // The groups come in while the clips are being compared.
  let running = false;
  const unsubscribe = app.subscribe(() => {
    if (!running) render();
  });
  dialog.addEventListener('close', unsubscribe);
  dialog.addEventListener('cancel', (event) => {
    if (running) event.preventDefault();
  });

  start.addEventListener('click', async () => {
    const chosen = shown().filter((group) => ticked.has(groupKey(group)));
    const names = chosen.map((group) => format.title(app.clip(group.ids.at(-1))));
    running = true;
    const bar = h('progress', { max: 1, value: 0 });
    const status = h('p', {}, t('storage.preparing'));
    report = (value, phase) => {
      bar.value = value;
      const i = Math.min(chosen.length - 1, Math.floor(value * chosen.length));
      const step = STEPS[phase] ? t(STEPS[phase]) : t('common.percent', { n: Math.round(value * 100) });
      status.textContent = t('dup.progress', { n: i + 1, count: chosen.length, name: names[i], step });
    };
    body.replaceChildren(h('section', { class: 'storage-block' }, h('h3', {}, t('dup.working')), status, bar));
    actions.replaceChildren(button({ label: t('storage.stop'), onClick: () => call('cancelExport') }));

    const { ok, value } = await call('joinReplays', chosen.map((group) => group.ids), mode.id);
    running = false;
    report = null;
    actions.replaceChildren(button({ label: t('common.close'), class: 'primary', autofocus: true, onClick: () => dialog.close() }));
    body.replaceChildren(ok ? results(value) : h('p', {}, t('dup.notStarted')));
  });
}

function results({ done = [], skipped = [], canceled = false }) {
  const before = done.reduce((sum, item) => sum + item.before, 0);
  const after = done.reduce((sum, item) => sum + item.after, 0);
  const kept = [...done.flatMap((item) => item.left), ...skipped];
  return h('section', { class: 'storage-block' },
    h('h3', {}, canceled ? t('dup.stopped') : t('dup.finished')),
    done.length
      ? h('p', {}, t('dup.result', { count: done.length, before: format.bytes(before), after: format.bytes(after), saved: format.bytes(before - after) }))
      : h('p', {}, t('dup.noneDone')),
    done.length > 0 && (done.every((item) => item.trashed)
      ? h('div', { class: 'notice' }, icon('trash'), h('span', {}, h('b', {}, t('storage.binned')), t('storage.binnedText')))
      : h('div', { class: 'notice warn' }, icon('trash'), h('span', {}, h('b', {}, t('storage.aside'))))),
    kept.length > 0 && h('div', { class: 'storage-skipped' },
      h('b', {}, t('storage.kept')),
      ...kept.map((item) => h('div', {}, h('span', { class: 'ellipsis' }, item.name), h('small', {}, item.reason)))));
}
