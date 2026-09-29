import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, ipcMain, protocol, shell, systemPreferences, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { LANGUAGES, QUALITIES, VOICE_IPC, VOICE_SCHEME, type OsMicAccess } from '../shared/voice.ts';
import { voiceAssets } from './voice/assets.ts';
import { createWhisper } from './voice/whisper.ts';

// The one place where untrusted audio becomes a request. Whisper works in 30 s windows, so a minute is generous.
const MAX_SECONDS = 60;
const transcribeRequest = z.object({
  pcm: z.instanceof(Uint8Array).refine((b) => b.byteLength % 2 === 0 && b.byteLength <= MAX_SECONDS * 32_000, 'pcm must be whole 16-bit samples, at most 60 s'),
  language: z.enum(LANGUAGES),
});
const quality = z.enum(QUALITIES);

// Models are big and shared by every profile, so they live in the OS cache folder and not in userData.
const cacheHome = () => (process.platform === 'darwin' ? join(homedir(), 'Library/Caches') : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')));
const cacheDir = () => join(cacheHome(), 'online-office', 'whisper');

const MIC_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

// A test run never touches the real microphone: Chromium plays a WAV (or its own beep) instead, macOS is never asked,
// and nothing can raise a permission dialog on the owner's screen. `OFFICE_TEST_AUDIO` names the WAV.
const testRun = !!process.env.OFFICE_TEST_RUN;

// Both have to happen before the app is ready.
export function prepareVoice() {
  protocol.registerSchemesAsPrivileged([{ scheme: VOICE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  if (!testRun) return;
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  const wav = process.env.OFFICE_TEST_AUDIO;
  if (!wav) return;
  // %noloop plays the file once, so a phrase is not heard again on every lap. Chromium's audio service is sandboxed and
  // cannot read the file (it logs "Try disabling the sandbox"), so only a run that plays a WAV drops the sandbox.
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${wav}%noloop`);
  app.commandLine.appendSwitch('no-sandbox');
}

function osMicAccess(): OsMicAccess {
  if (testRun || (process.platform !== 'darwin' && process.platform !== 'win32')) return { kind: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  switch (status) {
    case 'granted':
      return { kind: 'granted' };
    case 'not-determined':
      return { kind: 'needs_prompt' };
    case 'denied':
    case 'restricted':
      return { kind: 'denied' };
    case 'unknown':
      // The renderer tells a working microphone from a dead one by its samples, so it is left to try.
      return { kind: 'granted' };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

async function requestMicAccess(): Promise<OsMicAccess> {
  const now = osMicAccess();
  if (now.kind !== 'needs_prompt') return now;
  // The boolean is not read. When macOS cannot show the dialog it answers false at once and leaves the status at
  // not-determined, which only the status afterwards tells apart from a refusal.
  await systemPreferences.askForMediaAccess('microphone');
  return osMicAccess();
}

type Options = { window: () => BrowserWindow | null; userData: string };

// Owns the whisper service and everything voice-related that crosses the process boundary. Register once per app run.
export function startVoice({ window, userData }: Options) {
  const assets = voiceAssets(app.getAppPath());
  protocol.handle(VOICE_SCHEME, (request) => assets(request.url));

  const whisper = createWhisper({
    cacheDir: cacheDir(),
    pidFile: join(userData, 'whisper-server.pid'),
    onEngine(engine) {
      const win = window();
      if (win && !win.isDestroyed()) win.webContents.send(VOICE_IPC.engineChanged, engine);
    },
  });

  // Anything that is not our own window gets nothing, as in ipc.ts.
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === window()?.webContents;
  const handle = (channel: string, run: (raw: unknown) => unknown) =>
    ipcMain.handle(channel, (e, raw: unknown) => {
      if (!trusted(e)) throw new Error('Untrusted sender');
      return run(raw);
    });
  const listen = (channel: string, run: (raw: unknown) => void) =>
    ipcMain.on(channel, (e, raw: unknown) => {
      if (trusted(e)) run(raw);
    });

  handle(VOICE_IPC.engine, () => whisper.engine());
  handle(VOICE_IPC.transcribe, (raw) => {
    const { pcm, language } = transcribeRequest.parse(raw);
    return whisper.transcribe(pcm, language);
  });
  handle(VOICE_IPC.micStatus, osMicAccess);
  handle(VOICE_IPC.micRequest, requestMicAccess);
  listen(VOICE_IPC.useQuality, (raw) => {
    const parsed = quality.safeParse(raw);
    if (parsed.success) void whisper.use(parsed.data);
  });
  listen(VOICE_IPC.recheck, () => void whisper.recheck());
  listen(VOICE_IPC.micSettings, () => {
    // A test that clicks the button must not open System Settings on the owner's screen.
    if (testRun) console.log('[voice] would open the microphone settings');
    else void shell.openExternal(MIC_SETTINGS);
  });

  return { shutdown: () => void whisper.stop() };
}
