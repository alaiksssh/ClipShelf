const { t } = require('./i18n');
// What the user sorts clips with: categories, tags, names and moments.
const NAME_LENGTH = 60;
const CATEGORY_LENGTH = 30;
const TAG_LENGTH = 30;
const MAX_MARKS = 500;
const MARK_COLORS = ['gpu', 'ram', 'cpu', 'net', 'disk', 'charge', 'warn', 'violet']; // As in moments.mjs.

/** A colour at random, but not that of the mark before. */
function pickColor(items) {
  const last = items.filter((item) => item.kind === 'mark').at(-1)?.color;
  const choices = MARK_COLORS.filter((color) => color !== last);
  return choices[Math.floor(Math.random() * choices.length)];
}

const text = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

const cleanTitle = (value) => text(value, NAME_LENGTH);
const cleanCategory = (value) => text(value, CATEGORY_LENGTH);
const cleanTag = (value) => text(value, TAG_LENGTH).replace(/^#+/, '').trim().toLowerCase();

class Organizer {
  constructor({ library, settings }) {
    Object.assign(this, { library, settings });
    this.meta = library.meta;
    if (!Array.isArray(settings.data.categories)) settings.data.categories = [];
    if (!Array.isArray(settings.data.tags)) settings.data.tags = [];
  }

  /** The ones created, in their order, then any that only a clip still has. */
  categories() {
    const names = [...this.settings.data.categories];
    for (const clip of this.library.clips.values()) {
      const name = this.meta.data[clip.key]?.category;
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  addCategory(value) {
    const name = cleanCategory(value);
    if (!name) throw new Error(t('organizer.categoryName'));
    const known = this.categories().find((other) => sameName(other, name));
    if (known) return known;
    this.settings.data.categories.push(name);
    this.settings.save();
    this.library.emit('change');
    return name;
  }

  renameCategory(from, value) {
    const typed = cleanCategory(value);
    if (!typed) throw new Error(t('organizer.categoryName'));
    // Renamed to an existing one: they become one category.
    const to = this.categories().find((name) => name !== from && sameName(name, typed)) || typed;
    if (to === from) return to;
    const list = this.settings.data.categories.map((name) => (name === from ? to : name));
    this.settings.data.categories = [...new Set(list.includes(to) ? list : [...list, to])];
    this.settings.save();
    this.rewrite((meta) => meta.category === from && { category: to });
    return to;
  }

  removeCategory(name) {
    this.settings.data.categories = this.settings.data.categories.filter((other) => other !== name);
    this.settings.save();
    this.rewrite((meta) => meta.category === name && { category: '' });
  }

  /** Tags created ahead, before any clip has them. */
  createdTags() {
    return [...this.settings.data.tags];
  }

  addTag(value) {
    const tag = cleanTag(value);
    if (!tag) throw new Error(t('organizer.tagName'));
    if (!this.settings.data.tags.includes(tag)) {
      this.settings.data.tags.push(tag);
      this.settings.save();
      this.library.emit('change');
    }
    return tag;
  }

  renameTag(from, value) {
    const to = cleanTag(value);
    if (!to) throw new Error(t('organizer.tagName'));
    this.settings.data.tags = [...new Set(this.settings.data.tags.map((tag) => (tag === from ? to : tag)))];
    this.settings.save();
    this.rewrite((meta) => meta.tags?.includes(from)
      && { tags: [...new Set(meta.tags.map((tag) => (tag === from ? to : tag)))] });
    return to;
  }

  removeTag(name) {
    this.settings.data.tags = this.settings.data.tags.filter((tag) => tag !== name);
    this.settings.save();
    this.rewrite((meta) => meta.tags?.includes(name) && { tags: meta.tags.filter((tag) => tag !== name) });
  }

  /** Kept versions are changed too, so that going back does not bring an old name back. */
  rewrite(change) {
    for (const [key, meta] of Object.entries(this.meta.data)) {
      const patch = change(meta);
      if (patch) this.meta.data[key] = { ...meta, ...patch };
    }
    this.meta.save();
    this.library.emit('change');
  }

  editMoments(clipId, edit) {
    const clip = this.library.get(clipId);
    if (!clip.key) throw new Error(t('clip.notReady'));
    const state = this.meta.data[clip.key]?.moments || {};
    const items = state.items || [];
    let next;
    let added = null;

    if (edit.add) {
      const time = Number(edit.add.time);
      if (!Number.isFinite(time) || time < 0 || time > clip.duration) throw new Error(t('organizer.markOutside'));
      if (items.length >= MAX_MARKS) throw new Error(t('organizer.tooManyMarks'));
      added = items.reduce((max, moment) => Math.max(max, moment.id), 0) + 1;
      next = [...items, { id: added, kind: 'mark', time, name: cleanTitle(edit.add.name), color: pickColor(items) }];
      next.sort((a, b) => a.time - b.time);
    } else if (edit.name) {
      const { id, value } = edit.name;
      next = items.map((moment) => (moment.id === id ? { ...moment, name: cleanTitle(value) } : moment));
    } else if (edit.color) {
      const { id, value } = edit.color;
      if (!MARK_COLORS.includes(value)) throw new Error(t('organizer.unknownColor'));
      next = items.map((moment) => (moment.id === id && moment.kind === 'mark' ? { ...moment, color: value } : moment));
    } else if (edit.remove !== undefined) {
      next = items.filter((moment) => moment.id !== edit.remove);
    } else if (edit.redetect) {
      this.library.setMoments(clip.key, { ...state, items, detected: 0 });
      return null;
    } else {
      throw new Error(t('organizer.unknownAction'));
    }
    this.library.setMoments(clip.key, { ...state, items: next });
    return added;
  }
}

module.exports = { Organizer, cleanTitle, cleanCategory, cleanTag };
