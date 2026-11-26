import test from 'node:test';
import assert from 'node:assert/strict';
import { notesFor, HEADINGS } from '../src/shared/releaseNotes.mjs';

// As GitHub renders the notes that publish.cjs writes.
const HTML = `<h3>Nouveautés</h3>
<ul>
<li>Le plein écran est réservé aux clips.</li>
<li>Kills, morts &amp; repères : une flèche en bas.</li>
</ul>
<h3>What's new</h3>
<ul>
<li>Full screen is for clips <strong>only</strong>.</li>
<li>Kills, deaths &amp; marks: an arrow at the bottom.</li>
</ul>
<p>Première installation : <code>ClipShelf-Setup-1.13.4.exe</code></p>`;

test('the list of the language of the app, as plain text', () => {
  assert.deepEqual(notesFor(HTML, 'fr'), ['Le plein écran est réservé aux clips.', 'Kills, morts & repères : une flèche en bas.']);
  assert.deepEqual(notesFor(HTML, 'en'), ['Full screen is for clips only.', 'Kills, deaths & marks: an arrow at the bottom.']);
});

test('Markdown, as in a file, reads the same', () => {
  const markdown = `### ${HEADINGS.fr}\n- Un\n- Deux\n\n### ${HEADINGS.en}\n- One\n- Two\n\nFirst install: below.`;
  assert.deepEqual(notesFor(markdown, 'en'), ['One', 'Two']);
  assert.deepEqual(notesFor(markdown, 'fr'), ['Un', 'Deux']);
});

test('notes of older releases, in one language without heading, are shown as they are', () => {
  assert.deepEqual(notesFor('<ul><li>Transitions</li><li>Historique</li></ul><p>Première installation</p>', 'en'), ['Transitions', 'Historique']);
  assert.deepEqual(notesFor('- A\n- B', 'fr'), ['A', 'B']);
});

test('several versions at once: the newest is read first', () => {
  const notes = [{ version: '1.13.4', note: `<h3>What's new</h3><ul><li>New</li></ul>` }, { version: '1.13.3', note: '<ul><li>Old</li></ul>' }];
  assert.deepEqual(notesFor(notes, 'en'), ['New']);
});

test('no notes, or nothing readable in them: nothing', () => {
  for (const notes of [null, undefined, '', '<p>Just a line</p>', []]) assert.deepEqual(notesFor(notes, 'fr'), []);
});

test('tags and entities never pass through', () => {
  const [item] = notesFor('<ul><li><img src=x onerror="alert(1)">A &lt;b&gt; &#233;t&#xE9;</li></ul>', 'fr');
  assert.equal(item, 'A <b> été');
});
