import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OfficeApi, type ServerMessage } from '../shared/protocol.ts';
import { voiceApi } from './voice.ts';

const office: OfficeApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  send: (msg) => ipcRenderer.send(IPC.send, msg),
  subscribe(cb) {
    const listener = (_e: unknown, msg: ServerMessage) => cb(msg);
    ipcRenderer.on(IPC.event, listener);
    return () => void ipcRenderer.removeListener(IPC.event, listener);
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  revealFolder: (path) => ipcRenderer.send(IPC.revealFolder, path),
  voice: voiceApi,
};

contextBridge.exposeInMainWorld('office', office);
