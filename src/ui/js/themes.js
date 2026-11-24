import { t } from './i18n.js';
// Colour themes. Every colour of the app comes from these properties.
export const THEMES = [
  {
    id: 'periph',
    name: t('theme.default'),
    colors: { bg: '#0d0f14', surface: '#141720', 'surface-alt': '#1b1f2a', text: '#f2f4f8', dim: '#8a93a6', off: '#4b5365', accent: '#22d3ee', 'on-accent': '#0d0f14' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    detail: t('theme.graphiteDetail'),
    colors: { bg: '#1a1a1a', surface: '#232323', 'surface-alt': '#2c2c2c', text: '#e4e4e4', dim: '#9a9a9a', off: '#5a5a5a', accent: '#2d8ceb', 'on-accent': '#ffffff' },
  },
  {
    id: 'midnight',
    name: t('theme.midnight'),
    colors: { bg: '#0a0e1a', surface: '#10172a', 'surface-alt': '#172038', text: '#eef2ff', dim: '#8b95b5', off: '#475070', accent: '#818cf8', 'on-accent': '#0a0e1a' },
  },
  {
    id: 'oled',
    name: t('theme.oled'),
    colors: { bg: '#000000', surface: '#0a0a0b', 'surface-alt': '#141416', text: '#f5f5f5', dim: '#8a8a8f', off: '#45454a', accent: '#22d3ee', 'on-accent': '#000000' },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    colors: { bg: '#120c12', surface: '#1b121b', 'surface-alt': '#241824', text: '#fbeffa', dim: '#a68fa5', off: '#5c4a5b', accent: '#f472b6', 'on-accent': '#120c12' },
  },
  {
    id: 'forest',
    name: t('theme.forest'),
    colors: { bg: '#0b120e', surface: '#111a15', 'surface-alt': '#18241d', text: '#eef6f0', dim: '#8aa394', off: '#465a4d', accent: '#4ade80', 'on-accent': '#0b120e' },
  },
];

export const themeOf = (id) => THEMES.find((theme) => theme.id === id) || THEMES[0];

export function applyTheme(id) {
  const theme = themeOf(id);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty(`--${name}`, value);
  root.dataset.theme = theme.id;
  return theme;
}
