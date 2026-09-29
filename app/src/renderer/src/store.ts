import { create } from 'zustand';
import type {
  BlockId,
  ClientMessage,
  Company,
  Employee,
  EmployeeId,
  HarnessStatus,
  InterruptStyle,
  Provider,
} from '../../shared/protocol.ts';

export type CameraMode = 'follow' | 'iso' | 'first';
export type MicMode = 'proximity' | 'push';
export type Lang = 'en-US' | 'pt-BR';
export type Modal = null | { kind: 'hire' } | { kind: 'block' } | { kind: 'whiteboard'; blockId: BlockId };

export type LogLine = { line: string; at: number };
export type Toast = { id: number; text: string; tone: 'info' | 'warn' | 'ok' };

// Settings the user is tuning while deciding how this should feel; kept across reloads.
type Settings = { camera: CameraMode; interrupt: InterruptStyle; mic: MicMode; lang: Lang };
const SETTINGS_KEY = 'online-office.settings';
const defaults: Settings = { camera: 'follow', interrupt: 'next', mic: 'proximity', lang: 'en-US' };

function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

type State = Settings & {
  company: Company | null;
  harnesses: Record<Provider, HarnessStatus> | null;
  logs: Record<string, LogLine[]>;
  bubbles: Record<string, { text: string; until: number }>;
  selectedId: EmployeeId | null;
  modal: Modal;
  helpOpen: boolean;
  cardMinimized: boolean;
  // Facts derived by the per-frame sim, published only when they change.
  talkingTo: EmployeeId | null;
  askerId: EmployeeId | null;
  voice: { supported: boolean; active: boolean; interim: string; note: string | null };
  toasts: Toast[];
};

export const useStore = create<State>()(() => ({
  ...loadSettings(),
  company: null,
  harnesses: null,
  logs: {},
  bubbles: {},
  selectedId: null,
  modal: null,
  helpOpen: false,
  cardMinimized: false,
  talkingTo: null,
  askerId: null,
  voice: { supported: true, active: false, interim: '', note: null },
  toasts: [],
}));

export const set = useStore.setState;
export const get = useStore.getState;

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  set({ [key]: value } as Pick<State, K>);
  const s = get();
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ camera: s.camera, interrupt: s.interrupt, mic: s.mic, lang: s.lang }),
  );
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
}

export function employeeById(id: EmployeeId | null): Employee | undefined {
  if (!id) return undefined;
  return get().company?.employees.find((e) => e.id === id);
}

// Blocked employees in the order they asked. This is the queue behind the owner.
export function waitingQueue(company: Company | null): Employee[] {
  if (!company) return [];
  return company.employees
    .filter((e) => e.status.kind === 'blocked_on_owner')
    .sort((a, b) => askedAt(a) - askedAt(b) || a.id.localeCompare(b.id));
}

export function askedAt(e: Employee) {
  return e.status.kind === 'blocked_on_owner' ? e.status.question.askedAt : Infinity;
}

export const send = (m: ClientMessage) => window.office.send(m);
