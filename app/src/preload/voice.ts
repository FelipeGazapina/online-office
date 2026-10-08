import { ipcRenderer } from 'electron';
import { VOICE_IPC, type VoiceApi, type VoiceEngine } from '../shared/voice.ts';

// invoke() wraps a failure as "Error invoking remote method 'voice:transcribe': Error: <why>", and the why is what the owner reads.
const unwrap = (err: unknown): never => {
  throw new Error(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(err));
};

export const voiceApi: VoiceApi = {
  engine: () => ipcRenderer.invoke(VOICE_IPC.engine),
  onEngine(cb) {
    const listener = (_e: unknown, engine: VoiceEngine) => cb(engine);
    ipcRenderer.on(VOICE_IPC.engineChanged, listener);
    return () => void ipcRenderer.removeListener(VOICE_IPC.engineChanged, listener);
  },
  useQuality: (quality) => ipcRenderer.send(VOICE_IPC.useQuality, quality),
  wake: () => ipcRenderer.send(VOICE_IPC.wake),
  recheck: () => ipcRenderer.send(VOICE_IPC.recheck),
  transcribe: (pcm, language) =>
    ipcRenderer.invoke(VOICE_IPC.transcribe, { pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), language }).catch(unwrap),
  mic: {
    status: () => ipcRenderer.invoke(VOICE_IPC.micStatus),
    request: () => ipcRenderer.invoke(VOICE_IPC.micRequest),
    openSettings: () => ipcRenderer.send(VOICE_IPC.micSettings),
  },
};
