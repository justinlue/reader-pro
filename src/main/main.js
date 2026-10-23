import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFonts } from './fonts.js';
import { flushState, loadState, updateState } from './store.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

app.setName('Reader');
// Lets test runs keep their state away from the real %APPDATA%\Reader.
if (process.env.READER_USER_DATA) app.setPath('userData', process.env.READER_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // app://reader/<path> serves files from src/, so ES modules and workers load from a
  // real origin instead of file://.
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);

  let win = null;

  const txtArg = (argv) =>
    argv.slice(1).reverse().find((a) => a.toLowerCase().endsWith('.txt') && existsSync(a)) ?? null;

  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const path = txtArg(argv);
    if (path) win.webContents.send('open-file', path);
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      const full = normalize(join(SRC, rel));
      if (!full.startsWith(SRC + sep)) return new Response('Forbidden', { status: 403 });
      try {
        const body = await readFile(full);
        return new Response(body, { headers: { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    ipcMain.handle('state:load', () => {
      const { window: _w, ...rest } = loadState();
      return rest;
    });
    ipcMain.on('state:save', (_e, rendererState) => updateState(rendererState));
    ipcMain.handle('dialog:open', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Open text file',
        filters: [
          { name: 'Text files', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('file:read', async (_e, path) => {
      const info = await stat(path);
      if (info.size > 512 * 1024 * 1024) throw new Error('File is larger than 512 MB');
      return new Uint8Array(await readFile(path));
    });
    ipcMain.handle('fonts:list', () => listFonts());
    ipcMain.on('window:fullscreen', () => win?.setFullScreen(!win.isFullScreen()));
    ipcMain.on('window:devtools', () => win?.webContents.toggleDevTools());

    const initial = txtArg(process.argv);
    ipcMain.handle('app:initial-file', () => initial);

    Menu.setApplicationMenu(null);
    win = createWindow();
    listFonts(); // warm the cache while the window loads
  });

  app.on('before-quit', flushState);
  app.on('window-all-closed', () => app.quit());

  function savedBounds() {
    const b = loadState().window;
    if (!b) return { width: 900, height: 1000 };
    // Ignore bounds that no longer intersect any display (monitor unplugged).
    const visible = screen.getAllDisplays().some(({ workArea: d }) =>
      b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y,
    );
    return visible ? b : { width: b.width, height: b.height };
  }

  function createWindow() {
    const b = savedBounds();
    const w = new BrowserWindow({
      ...b,
      minWidth: 360,
      minHeight: 400,
      title: 'Reader',
      backgroundColor: '#f6f1e7',
      show: false,
      webPreferences: {
        preload: join(SRC, 'main', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    if (b.maximized) w.maximize();
    w.once('ready-to-show', () => w.show());
    // Dropping a file must not navigate away from the app.
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const remember = () => {
      if (w.isFullScreen() || w.isMinimized()) return;
      updateState({ window: { ...w.getNormalBounds(), maximized: w.isMaximized() } });
    };
    w.on('resize', remember);
    w.on('move', remember);
    w.on('maximize', remember);
    w.on('unmaximize', remember);
    w.on('close', remember);

    w.loadURL('app://reader/renderer/index.html');
    return w;
  }
}
