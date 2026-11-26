import { button, call } from './dom.js';
import { t } from './i18n.js';

// The window covers the screen for two reasons: the user chose it (F11), or the editor shows the
// video alone. The main process holds both and answers with what the window does; leaving the
// video gives back the user's choice.
const state = { full: false, chosen: false, video: false };
const listeners = new Set();
let leave = null;

function show({ full, chosen }) {
  Object.assign(state, { full, chosen });
  // Windows may hide the native window buttons in full screen: this one then takes their place.
  // The page asks rather than assumes. The video alone has a button of its own.
  const buttons = navigator.windowControlsOverlay?.visible ?? true;
  const alone = full && !buttons;
  document.body.classList.toggle('full-screen', alone);
  leave.hidden = !alone || state.video;
  for (const listener of listeners) listener(state);
}

async function request(change) {
  Object.assign(state, change);
  const { ok, value } = await call('fullScreen', { chosen: state.chosen, video: state.video });
  if (ok) show(value);
}

export function installFullScreen() {
  leave = button({
    icon: 'cornersIn',
    title: t('full.leave'),
    class: 'ghost leave-full-screen',
    hidden: true,
    onClick: () => toggleFullScreen(),
  });
  document.body.append(leave);
  window.bridge.onFullScreen(show);
  navigator.windowControlsOverlay?.addEventListener('geometrychange', () => show(state));
  call('fullScreen').then(({ ok, value }) => ok && show(value));
}

export const isFullScreen = () => state.full;

/** F11: the whole app covers the screen, or no longer does. */
export function toggleFullScreen() {
  return request({ chosen: !state.chosen });
}

/** The editor shows the video alone, over the whole screen. */
export function setVideoFullScreen(video) {
  return request({ video });
}

export function onFullScreen(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
