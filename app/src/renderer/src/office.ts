import type { MailView } from '../../shared/mail.ts';
import type { EmployeeId, ServerMessage } from '../../shared/protocol.ts';
import { heard } from './audio.ts';
import { addChat, employeeById, get, set, toast } from './store.ts';

const LOG_CAP = 200;

export function addLog(employeeId: string, line: string, at: number) {
  set((s) => ({ logs: { ...s.logs, [employeeId]: [...(s.logs[employeeId] ?? []).slice(-(LOG_CAP - 1)), { line, at }] } }));
}

// Until the chat is rebuilt on the mailroom, what an employee deliberately says to the owner still lands in the drawer's transcript.
// An auto reply repeats text the employee already said, so it is skipped.
const seenMail = new Set<string>();
let mailSeeded = false;
function bridgeMail(view: MailView) {
  for (const m of view.tail) {
    if (seenMail.has(m.id)) continue;
    seenMail.add(m.id);
    if (mailSeeded && m.to === 'owner' && (m.kind === 'say' || (m.kind === 'reply' && !m.auto))) addChat(m.from as EmployeeId, 'employee', m.text);
  }
  mailSeeded = true;
}

export function applyServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      set({ company: msg.company, harnesses: msg.harnesses, catalogs: msg.catalogs, meetingDoor: msg.meetingDoor, taskBoards: msg.taskBoards, taskConnections: msg.taskConnections, mail: msg.mail });
      bridgeMail(msg.mail);
      if (msg.buildingRev !== get().buildingRev) void fetchBuilding();
      break;
    case 'building':
      if (msg.rev >= get().buildingRev) set({ building: msg.building, buildingRev: msg.rev });
      break;
    case 'build_rejected':
      toast(`That change is not allowed: ${[...new Set(msg.violations.map((v) => v.kind.replaceAll('_', ' ')))].join(', ')}.`, 'warn');
      break;
    case 'said': {
      const e = employeeById(msg.employeeId);
      addLog(msg.employeeId, `says: ${msg.text}`, Date.now());
      addChat(msg.employeeId, 'employee', msg.text);
      if (e && get().meetingDoor === 'open') heard(e, msg.text);
      break;
    }
    case 'mail':
      set({ mail: msg.view });
      bridgeMail(msg.view);
      break;
    case 'stream':
      // The bubble is whole once it lands in the mail view, so a closed stream is dropped.
      set((s) => {
        const { [msg.employeeId]: open, ...rest } = s.streams;
        return msg.done ? { streams: rest } : { streams: { ...rest, [msg.employeeId]: { text: (open?.text ?? '') + msg.delta, replyingTo: msg.replyingTo, at: Date.now() } } };
      });
      break;
    case 'history':
      break;
    case 'log':
      addLog(msg.employeeId, msg.line, msg.at);
      break;
    case 'error':
      toast(msg.message, 'warn');
      break;
  }
}

async function fetchBuilding() {
  const { building, rev } = await window.office.getBuilding();
  if (rev >= get().buildingRev) set({ building, buildingRev: rev });
}

export async function startOffice() {
  window.office.subscribe(applyServerMessage);
  let announced = '';
  window.office.update.subscribe((update) => {
    set({ update });
    if (update.status !== 'available' || update.version === announced) return;
    announced = update.version;
    const mouseHint = get().camera === 'iso' ? '' : ' Press C to free the mouse.';
    toast(`Online Office v${update.version} is available. Click Update at the top right.${mouseHint}`);
  });
  applyServerMessage(await window.office.getSnapshot());
}
