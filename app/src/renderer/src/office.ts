import type { MailView } from '../../shared/mail.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { heard } from './audio.ts';
import { enterBuild } from './hud/build/actions.ts';
import { employeeById, get, set, toast } from './store.ts';

const LOG_CAP = 200;

export function addLog(employeeId: string, line: string, at: number) {
  set((s) => ({ logs: { ...s.logs, [employeeId]: [...(s.logs[employeeId] ?? []).slice(-(LOG_CAP - 1)), { line, at }] } }));
}

// An owner post stays on screen as pending until the mail view carries it back under its `clientId`.
const PENDING_MS = 60_000;
function settlePending(view: MailView) {
  const now = Date.now();
  const echoed = new Set(view.tail.flatMap((m) => (m.key ? [m.key] : [])));
  set((s) => (s.pending.length === 0 ? s : { pending: s.pending.filter((p) => !echoed.has(p.clientId) && now - p.at < PENDING_MS) }));
}

export function applyServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      set({ company: msg.company, harnesses: msg.harnesses, catalogs: msg.catalogs, meetingDoor: msg.meetingDoor, boards: msg.boards, tasks: msg.tasks, boardSync: msg.boardSync, taskTime: msg.taskTime, taskConnections: msg.taskConnections, linearPeople: msg.linearPeople, mail: msg.mail });
      settlePending(msg.mail);
      if (msg.buildingRev !== get().buildingRev) void fetchBuilding();
      break;
    case 'building':
      if (msg.rev >= get().buildingRev) set({ building: msg.building, buildingRev: msg.rev });
      break;
    case 'build_incomplete':
      // The renderer saw a complete office but main did not, so the draft is still open: go back to it.
      enterBuild();
      toast('The office was not saved. The checklist shows what is missing.', 'warn');
      break;
    case 'build_rejected':
      toast(`That change is not allowed: ${[...new Set(msg.violations.map((v) => v.kind.replaceAll('_', ' ')))].join(', ')}.`, 'warn');
      break;
    case 'said': {
      const e = employeeById(msg.employeeId);
      addLog(msg.employeeId, `says: ${msg.text}`, Date.now());
      if (e && get().meetingDoor === 'open') heard(e, msg.text);
      break;
    }
    case 'mail':
      set({ mail: msg.view });
      settlePending(msg.view);
      break;
    case 'stream':
      // The bubble is whole once it lands in the mail view, so a closed stream is dropped.
      set((s) => {
        const { [msg.employeeId]: open, ...rest } = s.streams;
        return msg.done ? { streams: rest } : { streams: { ...rest, [msg.employeeId]: { text: (open?.text ?? '') + msg.delta, replyingTo: msg.replyingTo, at: Date.now() } } };
      });
      break;
    case 'history':
      set((s) => {
        const known = s.history[msg.convo]?.messages ?? [];
        const byId = new Map([...known, ...msg.messages].map((m) => [m.id, m]));
        return { history: { ...s.history, [msg.convo]: { messages: [...byId.values()].sort((a, b) => a.at - b.at), hasMore: msg.hasMore } } };
      });
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
