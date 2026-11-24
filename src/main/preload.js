const { contextBridge, ipcRenderer } = require('electron');

const methods = [
  'state', 'rescan', 'update', 'rename', 'analysis', 'proxy', 'reveal', 'copyPath', 'trash',
  'addFolder', 'removeFolder', 'setExportDir', 'welcomeInfo', 'addObsFolder', 'welcomeDone', 'newsSeen', 'installUpdate', 'export', 'discord', 'cancelExport', 'revealExport',
  'overwrite', 'revert',
  'addCategory', 'renameCategory', 'removeCategory', 'addTag', 'renameTag', 'removeTag',
  'moments', 'watching', 'setDetection', 'chooseLogo', 'automaticLogo', 'setTheme', 'setLanguage', 'showShortcuts',
  'storage', 'compress', 'joinReplays', 'installedGames', 'pickProgram', 'addGame', 'removeGame', 'sortPreview', 'setSorting',
];

// Resolves to { value } or { error }: rejected IPC promises would carry a technical prefix.
const api = Object.fromEntries(methods.map((name) => [name, (...args) => ipcRenderer.invoke(name, ...args)]));

contextBridge.exposeInMainWorld('bridge', {
  ...api,
  drag: (ids) => ipcRenderer.send('drag', ids),
  onChanged: (fn) => { ipcRenderer.on('changed', (_, data) => fn(data)); },
  onProgress: (fn) => { ipcRenderer.on('progress', (_, value, phase) => fn(value, phase)); },
  onJobLog: (fn) => { ipcRenderer.on('jobLog', (_, text, live) => fn(text, live)); },
  // { label } when a job starts, null when it ends.
  onJob: (fn) => { ipcRenderer.on('job', (_, job) => fn(job)); },
});
