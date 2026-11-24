import { t, language, decimal, bytes } from './i18n.js';

export { bytes };

const DAY = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const SHORT = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short' });
const CLOCK = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' });

export function duration(seconds, decimals = 0) {
  const unit = 10 ** decimals;
  const total = Math.max(0, Math.round(seconds * unit));
  const whole = Math.floor(total / unit);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const secs = String(whole % 60).padStart(2, '0');
  const fraction = decimals ? `.${String(total % unit).padStart(decimals, '0')}` : '';
  const start = hours ? `${hours}:${String(minutes).padStart(2, '0')}` : `${minutes}`;
  return `${start}:${secs}${fraction}`;
}

// The decimal point of the language, for the tenths of a time.
const POINT = decimal(0.5).replace(/\d/g, '');

/** A length of time, like "8.1 s". */
export function seconds(value) {
  if (value >= 59.95) return duration(value, 1).replace('.', POINT);
  return t('unit.seconds', { n: decimal(value, value < 0.95 ? 2 : 1) });
}

export function day(time) {
  const date = new Date(time).toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === new Date().toDateString()) return t('day.today');
  if (date === yesterday.toDateString()) return t('day.yesterday');
  const text = DAY.format(time);
  return text[0].toUpperCase() + text.slice(1);
}

export const when = (time) => `${SHORT.format(time)}, ${CLOCK.format(time)}`;

const AUTO_NAME = /20\d\d[-_.]\d\d[-_.]\d\d|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

/** The name given to the clip. Otherwise, as recorder file names are noise, the game and the date. */
export function title(clip) {
  if (clip.title) return clip.title;
  return AUTO_NAME.test(clip.name) ? `${clip.game || t('clip')} · ${when(clip.date)}` : clip.name;
}
