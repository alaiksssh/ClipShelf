import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { updatesEnabled } = require('../src/main/updater');

test('updates are looked for by an installed app only, never during a check', () => {
  assert.equal(updatesEnabled({ packaged: true, env: {} }), true);
  assert.equal(updatesEnabled({ packaged: false, env: {} }), false, 'run from the sources');
  assert.equal(updatesEnabled({ packaged: true, env: { CLIPSHELF_DATA: 'C:\temp\check' } }), false, 'a check with its own data');
  assert.equal(updatesEnabled({ packaged: true, env: { CLIPSHELF_UPDATES: 'off' } }), false);
});
