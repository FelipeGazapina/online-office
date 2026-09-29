import { join } from 'node:path';
import { app, BrowserWindow, session, type WebContents } from 'electron';
import { startOffice } from './ipc.ts';
import { detectHarnesses } from './office/adapters/index.ts';
import { startOfficeMcp } from './office/mcp.ts';
import { MemoryStore } from './office/memory.ts';

// Tests point this at a scratch dir. Moving the whole profile, not just company.json, keeps their
// localStorage and lock file apart from the real app's.
if (process.env.OFFICE_DATA_DIR) app.setPath('userData', process.env.OFFICE_DATA_DIR);

// Set by the test driver. A test run is not the owner's office, so its window is never shown, has no Dock icon,
// and says what it is if it ever becomes visible.
const testRun = !!process.env.OFFICE_TEST_RUN;

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: testRun ? 'Online Office (automated test)' : 'Online Office',
    show: !testRun,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The world is stepped by hand in tests, but timers and frames must keep running in a window nobody sees.
      backgroundThrottling: !testRun,
    },
  });
  win.on('closed', () => (win = null));
  // The renderer only ever shows our own page. Links and popups do not get a second window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  // The page reads ?test to put the banner up.
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${testRun ? '?test' : ''}`);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), testRun ? { query: { test: '1' } } : {});
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
    if (testRun) app.dock?.hide();
    // Voice input needs the microphone and the arrival alert needs OS notifications. Nothing else.
    const allowed = (wc: WebContents | null, permission: string) =>
      wc === win?.webContents && (permission === 'media' || permission === 'notifications');
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)));

    // The MCP server has to be listening before the first session is built, and memory lives beside company.json.
    const userData = app.getPath('userData');
    const mcp = await startOfficeMcp();
    const office = startOffice({
      dataFile: join(userData, 'company.json'),
      harnesses: await harnesses,
      window: () => win,
      services: { mcp, memory: MemoryStore.open(join(userData, 'memory')) },
    });
    app.on('will-quit', () => {
      office.shutdown();
      void mcp.close();
    });

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
