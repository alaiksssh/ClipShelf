import { h, button, icon } from './dom.js';
import { openDialog, dialogHead } from './dialogs.js';
import { t } from './i18n.js';

const clean = (value) => value.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim().toLowerCase().slice(0, 30);

/**
 * Ticks and unticks tags, or types new ones. Resolves to { add, remove }, or null when cancelled.
 * With several clips, a tag only some of them have stays as it is until it is clicked.
 */
export function editTags(clips, known) {
  return new Promise((resolve) => {
    const before = new Map();
    for (const tag of new Set([...known, ...clips.flatMap((clip) => clip.tags)])) {
      const having = clips.filter((clip) => clip.tags.includes(tag)).length;
      before.set(tag, having === clips.length ? true : having ? 'some' : false);
    }
    const now = new Map(before);
    let result = null;

    const list = h('div', { class: 'tag-picker' });
    const input = h('input', {
      class: 'field',
      spellcheck: 'false',
      placeholder: 'ace, clutch, flick…',
      maxlength: 200,
    });
    const render = () => {
      const typed = clean(input.value.split(',').at(-1));
      list.replaceChildren(...[...now].filter(([tag]) => tag.includes(typed)).map(([tag, on]) => h('button', {
        type: 'button',
        class: `tag ${on === true ? 'active' : ''} ${on === 'some' ? 'some' : ''}`,
        title: on === 'some' ? t('tags.some') : undefined,
        'aria-pressed': on === 'some' ? 'mixed' : String(on),
        onClick: () => {
          now.set(tag, on !== true);
          // What was typed found this tag: it is not a new one.
          const typed = input.value.split(',');
          typed.pop();
          input.value = typed.length ? `${typed.join(',')}, ` : '';
          render();
          input.focus();
        },
      }, on === true && icon('tick'), tag)));
    };
    const addTyped = () => {
      for (const tag of input.value.split(',').map(clean).filter(Boolean)) now.set(tag, true);
      input.value = '';
      render();
    };
    const submit = () => {
      addTyped();
      const changed = [...now].filter(([tag, on]) => on !== before.get(tag));
      result = {
        add: changed.filter(([, on]) => on === true).map(([tag]) => tag),
        remove: changed.filter(([tag, on]) => on === false && before.has(tag)).map(([tag]) => tag),
      };
      dialog.close();
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Closing restores focus to the opener, which this Enter would otherwise click.
      event.preventDefault();
      event.stopPropagation();
      if (input.value.trim() && !event.ctrlKey) addTyped();
      else submit();
    });

    const dialog = openDialog(
      dialogHead({ title: clips.length > 1 ? t('tags.of', { count: clips.length }) : t('lib.tags'), symbol: 'tag' }),
      h('p', {}, t('tags.text')),
      input,
      list,
      h('div', { class: 'dialog-actions' },
        button({ label: t('common.cancel'), onClick: () => dialog.close() }),
        button({ label: t('common.save'), class: 'primary', onClick: submit })),
    );
    render();
    input.focus();
    dialog.addEventListener('close', () => resolve(result));
  });
}
