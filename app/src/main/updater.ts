import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateState } from '../shared/protocol.ts';

const RECHECK_MS = 60 * 60 * 1000;

// electron-updater's HttpError message runs to several lines of headers.
const firstLine = (message: string) => message.split('\n', 1)[0];

type Options = { window: () => BrowserWindow | null };

export function startUpdater({ window }: Options): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  // The default, but the flow depends on it. MacUpdater hands the zip to Squirrel as soon as its own download ends,
  // quitAndInstall() waits for Squirrel, and a Squirrel refusal arrives as 'error'.
  autoUpdater.autoInstallOnAppQuit = true;

  let state: UpdateState = { status: 'checking' };
  const set = (next: UpdateState) => {
    state = next;
    const win = window();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.updateEvent, next);
  };
  const trusted = (e: IpcMainEvent) => e.sender === window()?.webContents;

  // electron-updater both rejects and emits 'error', so rejections are swallowed and 'error' alone moves the state.
  const check = () => {
    set({ status: 'checking' });
    void autoUpdater.checkForUpdates().catch(() => {});
  };
  const recheckIfIdle = () => {
    if (state.status === 'current' || state.status === 'check-failed') check();
  };
  const install = () => {
    if (state.status !== 'available') return;
    set({ status: 'downloading', version: state.version, percent: 0 });
    void autoUpdater.downloadUpdate().catch(() => {});
  };

  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', version: app.getVersion() }));
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') set({ ...state, percent: progress.percent });
  });
  autoUpdater.on('update-downloaded', () => {
    if (state.status !== 'downloading') return;
    set({ status: 'installing', version: state.version });
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (error) => {
    const message = firstLine(error.message);
    if (state.status === 'checking') set({ status: 'check-failed', message });
    else if (state.status === 'downloading' || state.status === 'installing') set({ status: 'update-failed', version: state.version, message });
  });

  ipcMain.on(IPC.updateSubscribe, (e) => {
    if (trusted(e)) e.sender.send(IPC.updateEvent, state);
  });
  ipcMain.on(IPC.updateCheck, (e) => {
    if (!trusted(e)) return;
    if (state.status === 'update-failed') check();
    else recheckIfIdle();
  });
  ipcMain.on(IPC.updateInstall, (e) => {
    if (trusted(e)) install();
  });

  check();
  setInterval(recheckIfIdle, RECHECK_MS).unref();
}
