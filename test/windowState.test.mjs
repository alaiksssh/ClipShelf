import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { placeWindow, windowState } = require('../src/main/windowState');

const fakeWindow = ({ maximized = false, fullScreen = false } = {}) => ({
  getNormalBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
  isMaximized: () => maximized,
  isFullScreen: () => fullScreen,
});

test('a window keeps its place and whether it was maximized', () => {
  assert.deepEqual(windowState(fakeWindow({ maximized: true })),
    { x: 10, y: 20, width: 1200, height: 800, maximized: true });
});

test('a window closed in full screen keeps whether it was maximized before', () => {
  // Windows reports a window in full screen as not maximized.
  assert.equal(windowState(fakeWindow({ fullScreen: true }), { maximizedBefore: true }).maximized, true);
  assert.equal(windowState(fakeWindow({ fullScreen: true }), { maximizedBefore: false }).maximized, false);
  // Out of full screen, what the window says counts, whatever was kept before.
  assert.equal(windowState(fakeWindow({ maximized: false }), { maximizedBefore: true }).maximized, false);
});

const MIN = { width: 980, height: 640 };
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -2560, y: 0, width: 2560, height: 1400 };

test('a window opens where it was, on the screen it was on', () => {
  assert.deepEqual(placeWindow({ x: 100, y: 80, width: 1200, height: 800 }, [primary, left], MIN), { x: 100, y: 80, width: 1200, height: 800 });
  assert.deepEqual(placeWindow({ x: -2000, y: 50, width: 1500, height: 900 }, [primary, left], MIN), { x: -2000, y: 50, width: 1500, height: 900 });
});

test('a window half off its screen comes back whole on it', () => {
  assert.deepEqual(placeWindow({ x: 1500, y: -30, width: 1200, height: 800 }, [primary], MIN), { x: 720, y: 0, width: 1200, height: 800 });
});

test('a window whose screen is gone opens on the primary one, no bigger than it and no smaller than the minimum', () => {
  assert.deepEqual(placeWindow({ x: -2000, y: 50, width: 2400, height: 1300 }, [primary], MIN), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(placeWindow({ x: 50, y: 50, width: 300, height: 200 }, [primary], MIN), { x: 50, y: 50, width: 980, height: 640 });
});

test('nothing kept, or something unreadable: the default size', () => {
  assert.equal(placeWindow(undefined, [primary], MIN), null);
  assert.equal(placeWindow({ x: 'a', y: 0, width: 10, height: 10 }, [primary], MIN), null);
});
