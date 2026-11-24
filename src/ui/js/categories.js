// Categories are shown, picked and managed the same way in the library and in the editor.
import { showMenu } from './menu.js';
import { t } from './i18n.js';

const COLORS = ['gpu', 'ram', 'warn', 'ok', 'cpu', 'net', 'charge', 'disk', 'low'];

export function categoryColor(categories, name) {
  return COLORS[Math.max(0, categories.indexOf(name)) % COLORS.length];
}

/** `place` is { x, y } or { anchor }. */
export function pickCategory(app, clips, place) {
  const { categories = [] } = app.state;
  const { actions } = app;
  const current = clips.every((clip) => clip.category === clips[0].category) ? clips[0].category : null;

  showMenu({
    ...place,
    title: t('categories.title'),
    selectable: true,
    items: [
      ...categories.map((name) => ({
        label: name,
        icon: 'category',
        tint: categoryColor(categories, name),
        checked: name === current,
        run: () => actions.setCategory(clips, name),
      })),
      categories.length > 0 && '-',
      { label: t('categories.new'), icon: 'plus', tint: 'accent', run: () => actions.newCategory(clips) },
      current && { label: t('categories.none'), icon: 'close', run: () => actions.setCategory(clips, '') },
    ],
  });
}
