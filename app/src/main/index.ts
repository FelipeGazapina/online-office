import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, safeStorage, screen, session, shell, type WebContents } from 'electron';
import { startOffice } from './ipc.ts';
import { configureCursorStore } from './office/adapters/cursor.ts';
import { detectHarnesses, setCodexRoot } from './office/adapters/index.ts';
import { startOfficeMcp } from './office/mcp.ts';
import { MemoryStore } from './office/memory.ts';
import { TaskBoardService } from './office/task-board.ts';
import { startUpdater } from './updater.ts';
import { prepareVoice, startVoice } from './voice.ts';

// Tests point this at a scratch dir. Moving the whole profile, not just company.json, keeps their
// localStorage and lock file apart from the real app's.
if (process.env.OFFICE_DATA_DIR) app.setPath('userData', process.env.OFFICE_DATA_DIR);
setCodexRoot(join(app.getPath('userData'), 'codex'));

// Set by the test driver. A test run is not the owner's office, so its window is never shown, has no Dock icon,
// and says what it is if it ever becomes visible.
const testRun = !!process.env.OFFICE_TEST_RUN;

let win: BrowserWindow | null = null;

prepareVoice();

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
    // Voice input needs the microphone, the arrival alert needs OS notifications, and FPS camera mode needs pointer lock.
    const allowed = (wc: WebContents | null, permission: string) =>
      wc === win?.webContents && (permission === 'media' || permission === 'notifications' || permission === 'pointerLock');
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)));
    // The portal is a transparent remote-control layer over the real desktop. The user still sees and
    // interacts with the actual macOS session; Electron only supplies the video surface and office HUD.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).then((sources) => {
        const current = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : undefined;
        const source = sources.find((candidate) => current && candidate.display_id === String(current.id)) ?? sources[0];
        callback(source ? { video: source } : {});
      }).catch(() => callback({}));
    });

    // The MCP server has to be listening before the first session is built, and memory lives beside company.json.
    const userData = app.getPath('userData');
    await configureCursorStore(join(userData, 'cursor-agents')).catch((err) => console.error(err));
    const mcp = await startOfficeMcp();
    const credentialsCodec = safeStorage.isEncryptionAvailable()
      ? { encode: (value: string) => safeStorage.encryptString(value).toString('base64'), decode: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')) }
      : undefined;
    const office = startOffice({
      dataFile: join(userData, 'company.json'),
      harnesses: await harnesses,
      window: () => win,
      services: {
        mcp,
        memory: MemoryStore.open(join(userData, 'memory')),
        taskBoards: new TaskBoardService({ openUrl: (url) => shell.openExternal(url), credentialsFile: join(userData, 'task-board-credentials.json'), credentialsCodec }),
        openUrl: (url) => shell.openExternal(url),
      },
    });
    const voice = startVoice({ window: () => win, userData });
    startUpdater({ window: () => win });
    app.on('will-quit', () => {
      office.shutdown();
      void mcp.close();
      voice.shutdown();
    });

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
