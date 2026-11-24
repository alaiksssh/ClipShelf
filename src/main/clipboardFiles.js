// Puts a file on the clipboard the way the Explorer copies it, so that Ctrl+V in Discord sends it.
//
// Electron's clipboard only holds text and images, while Windows PowerShell can hold files. The path
// goes through the environment, never into the command, so no file name can change the command.
// Check scripts replace `copy` and `held`, so that a test run never touches the user's clipboard:
// callers must call them as `clipboardFiles.copy(...)` and `clipboardFiles.held()`.
const { execFile } = require('node:child_process');
const path = require('node:path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function copy(file) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:CLIPSHELF_COPY'], {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, CLIPSHELF_COPY: file },
    }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
  });
}

/** The paths of the files on the clipboard, put there by `copy` or by the Explorer. */
function held() {
  return new Promise((resolve, reject) => {
    // UTF-8 out, or names with accents come back mangled and never match.
    const command = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
      + 'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 15000,
    }, (error, stdout, stderr) => (error
      ? reject(new Error(stderr.trim() || error.message))
      : resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))));
  });
}

module.exports = { copy, held };
