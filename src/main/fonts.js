// Installed font families, read once per run through .NET's InstalledFontCollection.

import { execFile } from 'node:child_process';

const SCRIPT =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  'Add-Type -AssemblyName System.Drawing;' +
  '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';

let pending = null;

export function listFonts() {
  pending ??= new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        resolve([...new Set(names)].sort((a, b) => a.localeCompare(b)));
      },
    );
  });
  return pending;
}
