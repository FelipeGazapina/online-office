import { BRIDGE_PORT, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
import { heard } from './audio.ts';
import { employeeById, set, setSender, toast } from './store.ts';

const LOG_CAP = 200;

export function addLog(employeeId: string, line: string, at: number) {
  set((s) => ({ logs: { ...s.logs, [employeeId]: [...(s.logs[employeeId] ?? []).slice(-(LOG_CAP - 1)), { line, at }] } }));
}

export function applyServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      set({ company: msg.company });
      break;
    case 'said': {
      const e = employeeById(msg.employeeId);
      addLog(msg.employeeId, `says: ${msg.text}`, Date.now());
      if (e) heard(e, msg.text);
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

// Network boundary: everything past this function trusts the ServerMessage type.
function parse(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || !('type' in m)) return null;
  const msg = m as { type: unknown; company?: { employees?: unknown; blocks?: unknown } };
  switch (msg.type) {
    case 'snapshot':
      return Array.isArray(msg.company?.employees) && Array.isArray(msg.company?.blocks) ? (m as ServerMessage) : null;
    case 'said':
    case 'log':
    case 'error':
      return m as ServerMessage;
    default:
      return null;
  }
}

export function startBridge() {
  let ws: WebSocket | null = null;
  let attempt = 0;

  const connect = () => {
    set({ conn: 'connecting', retryAt: null });
    const sock = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      set({ conn: 'open', retryAt: null });
    };
    sock.onmessage = (ev) => {
      const msg = parse(ev.data);
      if (msg) applyServerMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      const delay = Math.min(8000, 600 * 2 ** attempt++);
      set({ conn: 'offline', retryAt: Date.now() + delay });
      setTimeout(connect, delay);
    };
    sock.onerror = () => sock.close();
  };

  setSender((m: ClientMessage) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  });
  connect();
}
