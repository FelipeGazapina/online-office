import type { ServerMessage } from '../../shared/protocol.ts';
import { heard } from './audio.ts';
import { addChat, employeeById, get, set, toast } from './store.ts';

const LOG_CAP = 200;

export function addLog(employeeId: string, line: string, at: number) {
  set((s) => ({ logs: { ...s.logs, [employeeId]: [...(s.logs[employeeId] ?? []).slice(-(LOG_CAP - 1)), { line, at }] } }));
}

export function applyServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      set({ company: msg.company, harnesses: msg.harnesses, meetingDoor: msg.meetingDoor });
      break;
    case 'said': {
      const e = employeeById(msg.employeeId);
      addLog(msg.employeeId, `says: ${msg.text}`, Date.now());
      addChat(msg.employeeId, 'employee', msg.text);
      if (e && get().meetingDoor === 'open') heard(e, msg.text);
      break;
    }
    case 'log':
      addLog(msg.employeeId, msg.line, msg.at);
      break;
    case 'error':
      toast(msg.message, 'warn');
      break;
  }
}

export async function startOffice() {
  window.office.subscribe(applyServerMessage);
  applyServerMessage(await window.office.getSnapshot());
}
