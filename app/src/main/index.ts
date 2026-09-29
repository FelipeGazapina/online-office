import { join } from 'node:path';
import { app, BrowserWindow, session, type WebContents } from 'electron';
import { startOffice } from './ipc.ts';
import { detectHarnesses } from './office/adapters/index.ts';

// Tests point this at a scratch dir. Moving the whole profile, not just company.json, keeps their
// localStorage and lock file apart from the real app's.
if (process.env.OFFICE_DATA_DIR) app.setPath('userData', process.env.OFFICE_DATA_DIR);

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Online Office',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('closed', () => (win = null));
  // The renderer only ever shows our own page. Links and popups do not get a second window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

// Two instances would both write company.json.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Probing the CLIs overlaps with Electron's own startup.
  const harnesses = detectHarnesses();
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  void app.whenReady().then(async () => {
    // Voice input needs the microphone and the arrival alert needs OS notifications. Nothing else.
    const allowed = (wc: WebContents | null, permission: string) =>
      wc === win?.webContents && (permission === 'media' || permission === 'notifications');
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)));

    const office = startOffice({
      dataFile: join(app.getPath('userData'), 'company.json'),
      harnesses: await harnesses,
      window: () => win,
    });
    app.on('will-quit', office.shutdown);

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
