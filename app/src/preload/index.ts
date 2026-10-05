import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OfficeApi, type ServerMessage, type UpdateState } from '../shared/protocol.ts';
import { voiceApi } from './voice.ts';

const office: OfficeApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  getBuilding: () => ipcRenderer.invoke(IPC.building),
  send: (msg) => ipcRenderer.send(IPC.send, msg),
  subscribe(cb) {
    const listener = (_e: unknown, msg: ServerMessage) => cb(msg);
    ipcRenderer.on(IPC.event, listener);
    return () => void ipcRenderer.removeListener(IPC.event, listener);
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  revealFolder: (path) => ipcRenderer.send(IPC.revealFolder, path),
  portal: {
    enter: () => ipcRenderer.send(IPC.portalEnter),
    leave: () => ipcRenderer.send(IPC.portalLeave),
    openHome: () => ipcRenderer.send(IPC.portalOpenHome),
    openTerminal: () => ipcRenderer.send(IPC.portalOpenTerminal),
    openSlack: () => ipcRenderer.send(IPC.portalOpenSlack),
    onExit(cb) {
      const listener = () => cb();
      ipcRenderer.on(IPC.portalExit, listener);
      return () => void ipcRenderer.removeListener(IPC.portalExit, listener);
    },
  },
  update: {
    check: () => ipcRenderer.send(IPC.updateCheck),
    install: () => ipcRenderer.send(IPC.updateInstall),
    subscribe(cb) {
      const listener = (_e: unknown, state: UpdateState) => cb(state);
      ipcRenderer.on(IPC.updateEvent, listener);
      ipcRenderer.send(IPC.updateSubscribe);
      return () => void ipcRenderer.removeListener(IPC.updateEvent, listener);
    },
  },
  voice: voiceApi,
};

contextBridge.exposeInMainWorld('office', office);
