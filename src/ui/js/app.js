import { call } from './dom.js';
import { createActions } from './actions.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { applyTheme } from './themes.js';
import { openWelcome } from './welcome.js';
import { installTooltips } from './tooltip.js';
import { createStatus } from './status.js';
import { openPalette } from './palette.js';
import { openNews } from './news.js';

const listeners = new Set();

const app = {
  state: { clips: [], folders: [], exportDir: '', scanned: false },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  clip(id) {
    return this.state.clips.find((clip) => clip.id === id);
  },

  /** A clip opened from the library starts playing at once. */
  openClip(id, order) {
    const clip = this.clip(id);
    if (!clip || clip.busy || clip.broken) return;
    library.hide();
    editor.open(clip, order, { play: true });
  },

  closeClip() {
    editor.close();
    app.status.set('hint', '');
    library.show();
  },
};

app.actions = createActions(app);
app.status = createStatus(app, document.querySelector('#status'));
const library = new Library(document.querySelector('#library'), app);
const editor = new Editor(document.querySelector('#editor'), app);
// For the command palette, which reaches both.
app.library = library;
app.editor = editor;

function receive(state) {
  if (state.theme !== app.state.theme) applyTheme(state.theme);
  app.state = state;
  for (const listener of [...listeners]) listener();
}

installTooltips();
window.bridge.onChanged(receive);
const initial = await call('state');
if (initial.ok) receive(initial.value);
// Over the library, which fills in behind it while the clips are read.
if (initial.ok && initial.value.welcome) openWelcome(app);
else if (initial.ok && initial.value.news) openNews(initial.value.news);

addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open], .menu')) return;
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette(app);
    return;
  }
  if (editor.clip) editor.key(event);
  else library.key(event);
});

// A file dropped on the window must not replace the app.
for (const type of ['dragover', 'drop']) addEventListener(type, (event) => event.preventDefault());
addEventListener('beforeunload', () => editor.flush());
