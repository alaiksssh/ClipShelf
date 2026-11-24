// Clip actions shared by the library and the editor.
import { call, toast } from './dom.js';
import { askText, confirmAction } from './dialogs.js';
import { bytes, title } from './format.js';
import { editTags } from './tagDialog.js';
import { gameChoices } from '/shared/gameList.mjs';
import { t } from './i18n.js';

export function createActions(app) {
  const ids = (clips) => clips.map((clip) => clip.id);
  const known = (pick) => [...new Set(app.state.clips.flatMap(pick))].filter(Boolean).sort();

  return {
    favorite(clips) {
      const value = !clips.every((clip) => clip.favorite);
      return call('update', ids(clips), { favorite: value });
    },

    setTitle: (clip, value) => call('update', [clip.id], { title: value }),

    async name(clip) {
      const shown = title(clip);
      const value = await askText({
        title: t('actions.nameTitle'),
        symbol: 'title',
        text: t('actions.nameText'),
        value: shown,
        maxLength: 60,
      });
      if (value !== null && value.trim() !== shown) await call('update', [clip.id], { title: value });
    },

    async tag(clips) {
      const created = app.state.tags || [];
      const changes = await editTags(clips, [...new Set([...known((clip) => clip.tags), ...created])].sort());
      if (!changes || (!changes.add.length && !changes.remove.length)) return;
      await call('update', ids(clips), { addTags: changes.add, removeTags: changes.remove });
    },

    untag: (clips, tag) => call('update', ids(clips), { removeTag: tag }),

    async renameTag(tag) {
      const value = await askText({
        title: t('actions.renameTag'),
        text: t('actions.renameTagText'),
        symbol: 'tag',
        value: tag,
        maxLength: 30,
      });
      if (value === null || !value.trim() || value.trim() === tag) return null;
      const result = await call('renameTag', tag, value);
      return result.ok ? result.value : null;
    },

    async removeTag(tag) {
      const confirmed = await confirmAction({
        title: t('actions.removeTag'),
        symbol: 'tag',
        text: t('actions.removeTagText', { tag }),
        action: t('common.delete'),
      });
      return confirmed && (await call('removeTag', tag)).ok;
    },

    setCategory: (clips, category) => call('update', ids(clips), { category }),

    async newTag(clips = []) {
      const value = await askText({
        title: t('lib.newTag'),
        symbol: 'tag',
        text: clips.length
          ? t('actions.newTagFor', { count: clips.length })
          : t('actions.newTagText'),
        maxLength: 30,
        action: t('common.create'),
      });
      if (!value?.trim()) return;
      const { ok, value: tag } = await call('addTag', value);
      if (ok && clips.length) await call('update', ids(clips), { addTags: [tag] });
    },

    async newCategory(clips = []) {
      const value = await askText({
        title: t('lib.newCategory'),
        symbol: 'category',
        text: t('actions.newCategoryText'),
        maxLength: 30,
        action: t('common.create'),
      });
      if (!value?.trim()) return;
      const { ok, value: name } = await call('addCategory', value);
      if (ok && clips.length) await call('update', ids(clips), { category: name });
    },

    async renameCategory(category) {
      const value = await askText({
        title: t('actions.renameCategory'),
        symbol: 'category',
        value: category,
        maxLength: 30,
      });
      if (value === null || !value.trim() || value.trim() === category) return null;
      const result = await call('renameCategory', category, value);
      return result.ok ? result.value : null;
    },

    async removeCategory(category) {
      const confirmed = await confirmAction({
        title: t('actions.removeCategory'),
        symbol: 'category',
        text: t('actions.removeCategoryText', { category }),
        action: t('common.delete'),
      });
      return confirmed && (await call('removeCategory', category)).ok;
    },

    async game(clips) {
      const value = await askText({
        title: t('lib.chooseGame'),
        symbol: 'game',
        text: t('actions.gameText'),
        value: clips.length === 1 ? clips[0].game : '',
        suggestions: gameChoices([...(app.state.games || []).map((game) => game.name), ...known((clip) => [clip.game])]),
      });
      if (value !== null) await call('update', ids(clips), { game: value });
    },

    async rename(clip) {
      const value = await askText({
        title: t('actions.renameClip'),
        text: t('actions.renameClipText'),
        value: clip.name,
        action: t('common.rename'),
      });
      if (value === null || value.trim() === clip.name) return null;
      const result = await call('rename', clip.id, value.trim());
      return result.ok ? result.value : null;
    },

    async trash(clips) {
      const size = bytes(clips.reduce((total, clip) => total + clip.size, 0));
      const single = clips.length === 1;
      const kept = clips.some((clip) => clip.hasPrevious) ? ` ${t('actions.trashKept')}` : '';
      const confirmed = await confirmAction({
        title: t('actions.trashTitle', { count: clips.length }),
        text: t('actions.trashText', { what: single ? clips[0].path : t('actions.selectedFiles'), size, kept }),
        action: t('lib.trash'),
        confirmFirst: true, // Del, then Enter.
      });
      if (!confirmed) return false;
      const { ok, value } = await call('trash', ids(clips));
      if (!ok) return false;
      if (value.length) toast(t('actions.trashFailed', { names: value.join(', ') }), 'error');
      else toast(t('actions.trashed'));
      return !value.length;
    },

    confirmRevert: () => confirmAction({
      title: t('actions.revertTitle'),
      symbol: 'history',
      danger: false,
      text: t('actions.revertText'),
      action: t('actions.revert'),
    }),

    async revert(clip) {
      const { ok, value } = await call('revert', clip.id);
      if (!ok || value.canceled) return null;
      toast(value.trashed
        ? t('actions.reverted')
        : t('actions.revertedKept'));
      return value.id;
    },

    reveal: (clip) => call('reveal', clip.id),

    async copyPath(clip) {
      if ((await call('copyPath', clip.id)).ok) toast(t('actions.pathCopied'));
    },
  };
}
