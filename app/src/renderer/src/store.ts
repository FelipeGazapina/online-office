import { create } from 'zustand';
import type {
  BlockId,
  ClientMessage,
  Company,
  Employee,
  EmployeeId,
  HarnessStatus,
  InterruptStyle,
  MeetingDoor,
  ModelCatalog,
  Provider,
  TaskBoardState,
  TaskConnectionState,
  UpdateState,
} from '../../shared/protocol.ts';
import type { Language, VoiceQuality } from '../../shared/voice.ts';
import { initialVoice, type VoiceState } from './voice/chip.ts';

export type CameraMode = 'follow' | 'iso' | 'first';
export type MicMode = 'proximity' | 'push';
export type Lang = 'en-US' | 'pt-BR' | 'auto';
export type ComputerView = 'office' | 'mirror';
// What each language setting means for listening (`stt`, what whisper is told) and for the employees' voices (`tts`).
export const LANGS: Record<Lang, { stt: Language; tts: 'en-US' | 'pt-BR' }> = {
  'en-US': { stt: 'en', tts: 'en-US' },
  'pt-BR': { stt: 'pt', tts: 'pt-BR' },
  // Whisper's json answer does not say which language it heard, so the employees keep an English voice.
  auto: { stt: 'auto', tts: 'en-US' },
};
export type Modal = null | { kind: 'hire'; bypassLimit?: boolean } | { kind: 'block' } | { kind: 'whiteboard'; blockId: BlockId } | { kind: 'github'; blockId: BlockId } | { kind: 'github_setup'; blockId: BlockId } | { kind: 'task_board'; blockId: BlockId; taskId?: string };

export type LogLine = { line: string; at: number };
export type ChatLine = { from: 'owner' | 'employee'; text: string; at: number };
export type Toast = { id: number; text: string; tone: 'info' | 'warn' | 'ok' };

// Settings the user is tuning while deciding how this should feel; kept across reloads.
type Settings = { camera: CameraMode; interrupt: InterruptStyle; mic: MicMode; lang: Lang; voiceQuality: VoiceQuality };
const SETTINGS_KEY = 'online-office.settings';
const defaults: Settings = { camera: 'follow', interrupt: 'next', mic: 'proximity', lang: 'en-US', voiceQuality: 'fast' };

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
  meetingDoor: MeetingDoor;
  catalogs: Record<Provider, ModelCatalog> | null;
  taskBoards: Record<string, TaskBoardState>;
  taskConnections: Record<'linear' | 'cronospark', TaskConnectionState>;
  logs: Record<string, LogLine[]>;
  chat: Record<EmployeeId, ChatLine[]>;
  bubbles: Record<string, { text: string; until: number }>;
  selectedId: EmployeeId | null;
  menu: { employeeId: EmployeeId; x: number; y: number } | null;
  modal: Modal;
  helpOpen: boolean;
  cardMinimized: boolean;
  computerMenu: boolean;
  portalMode: boolean;
  computerState: 'away' | 'seated';
  computerView: ComputerView;
  nearComputer: boolean;
  nearProjectComputer: BlockId | null;
  projectComputerId: BlockId | null;
  // Facts derived by the per-frame sim, published only when they change.
  talkingTo: EmployeeId | null;
  nearbyIds: EmployeeId[];
  askerId: EmployeeId | null;
  voice: VoiceState;
  toasts: Toast[];
  update: UpdateState | null;
};

export const useStore = create<State>()(() => ({
  ...loadSettings(),
  company: null,
  harnesses: null,
  meetingDoor: 'open',
  catalogs: null,
  taskBoards: {},
  taskConnections: { linear: { kind: 'needs_auth' }, cronospark: { kind: 'needs_auth' } },
  logs: {},
  chat: {},
  bubbles: {},
  selectedId: null,
  menu: null,
  modal: null,
  helpOpen: false,
  cardMinimized: false,
  computerMenu: false,
  portalMode: false,
  computerState: 'away',
  computerView: 'office',
  nearComputer: false,
  nearProjectComputer: null,
  projectComputerId: null,
  talkingTo: null,
  nearbyIds: [],
  askerId: null,
  voice: initialVoice,
  toasts: [],
  update: null,
}));

export const set = useStore.setState;
export const get = useStore.getState;

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  set({ [key]: value } as Pick<State, K>);
  const s = get();
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ camera: s.camera, interrupt: s.interrupt, mic: s.mic, lang: s.lang, voiceQuality: s.voiceQuality }),
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

const CHAT_CAP = 200;

export function addChat(employeeId: EmployeeId, from: ChatLine['from'], text: string) {
  set((s) => ({ chat: { ...s.chat, [employeeId]: [...(s.chat[employeeId] ?? []).slice(-(CHAT_CAP - 1)), { from, text, at: Date.now() }] } }));
}

export function send(m: ClientMessage) {
  // Only these messages carry words the owner said, so only they join the transcript.
  switch (m.type) {
    case 'answer':
    case 'interject':
      addChat(m.employeeId, 'owner', m.text);
      break;
    case 'assign':
      addChat(m.employeeId, 'owner', m.task);
      break;
  }
  window.office.send(m);
}
