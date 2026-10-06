import { create } from 'zustand';
import type {
  BlockId,
  ClientMessage,
  Company,
  Employee,
  EmployeeId,
  EmployeeRole,
  HarnessStatus,
  InterruptStyle,
  MeetingDoor,
  ModelCatalog,
  Provider,
  TaskConnectionState,
  UpdateState,
} from '../../shared/protocol.ts';
import type { Board, BoardId, BoardSync, Task, TaskId, TaskTime } from '../../shared/tasks.ts';
import type { StageHolds } from './boardView.ts';
import type { Aim } from './deskDrop.ts';
import { emptyMailView, type MailView, type Message, type MessageId } from '../../shared/mail.ts';
import type { Building, ItemId, PaintId, Rot, Vec2 } from '../../shared/space/index.ts';
import type { Language, VoiceQuality } from '../../shared/voice.ts';
import { initialVoice, type VoiceState } from './voice/chip.ts';

export type CameraMode = 'iso' | 'first';
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
// A hire opened by dropping a task on an empty desk: the block and the desk are the owner's choice already, the desk says the
// role, and the new hire starts the task.
export type HireFor = { taskId: TaskId; blockId: BlockId; deskId: ItemId; role: EmployeeRole };
export type Modal = null | { kind: 'hire'; bypassLimit?: boolean; for?: HireFor } | { kind: 'block' } | { kind: 'whiteboard'; blockId: BlockId } | { kind: 'github'; blockId: BlockId } | { kind: 'github_setup'; blockId: BlockId } | { kind: 'task_board'; blockId: BlockId; taskId?: TaskId; settings?: boolean; tray?: true } | { kind: 'linear_board'; blockId: BlockId };

// Where dismissing a dialog goes: out of the way, except a hire that a dropped card opened, which goes back to the board the
// card came from.
export const dismissed = (m: Modal): Modal => (m?.kind === 'hire' && m.for ? { kind: 'task_board', blockId: m.for.blockId } : null);

// A whole block in hand: turned `quarter` quarter turns since it was picked up. `grab` is where the pointer holds it, in
// cells from the middle of its bounding box, turned along with it so the block keeps hanging off the same point.
export type BlockCarry = { blockId: string; quarter: Rot; grab: Vec2 };
// What the owner is doing in build mode. `carry` is the placed item being moved, null for a new one.
export type BuildTool =
  | { kind: 'select' }
  | { kind: 'wall' }
  | { kind: 'room' }
  | { kind: 'floor' }
  | { kind: 'wallpaint' }
  | { kind: 'opening'; open: 'door' | 'window' | 'arch' }
  | { kind: 'item'; def: string; rot: Rot; carry: ItemId | null; blockId: string | null }
  | { kind: 'block'; carry: BlockCarry | null };
export type WallsMode = 'up' | 'cutaway' | 'down';
// `searching` is the search box having focus: the catalog lists everything. `peek` is the furniture card under the pointer, drawn as the cursor ghost.
export type BuildState = { tool: BuildTool; tab: string; search: string; searching: boolean; peek: string | null; fill: boolean; paint: PaintId; style: number; wallsMode: WallsMode; level: number };
// What the pointer is over, for the tooltip next to it. `verdict` is the rule check of the ghost, null when there is no ghost.
export type BuildCursor = { readout: { text: string; x: number; y: number; bad: boolean; anchored?: boolean } | null; verdict: { ok: boolean; text: string } | null; hover: ItemId | null };

export type LogLine = { line: string; at: number };
// A post the owner just sent, shown at once. The mail view takes over when it carries the same `clientId` as its key.
export type PendingPost = { clientId: string; to: string; text: string; as: 'request' | 'say'; at: number };
export type Toast = { id: number; text: string; tone: 'info' | 'warn' | 'ok' };

// Settings the user is tuning while deciding how this should feel; kept across reloads.
type Settings = { camera: CameraMode; interrupt: InterruptStyle; mic: MicMode; lang: Lang; voiceQuality: VoiceQuality };
const SETTINGS_KEY = 'online-office.settings';
const defaults: Settings = { camera: 'iso', interrupt: 'next', mic: 'proximity', lang: 'en-US', voiceQuality: 'fast' };

function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'), camera: 'iso' };
  } catch {
    return defaults;
  }
}

type State = Settings & {
  company: Company | null;
  // The building and the rev main last gave it. The scene draws it and the sim walks it.
  building: Building | null;
  buildingRev: number;
  // The story the owner is on. It and the ones below are drawn.
  story: number;
  // The story each employee is on, published by the sim when one changes.
  avatarFloors: Record<string, number>;
  // The last furniture clicked, for the build tools.
  pickedItem: ItemId | null;
  // Null in live mode. The build tools and the story the owner builds on, which the scene draws while it is set.
  build: BuildState | null;
  buildCursor: BuildCursor;
  harnesses: Record<Provider, HarnessStatus> | null;
  meetingDoor: MeetingDoor;
  catalogs: Record<Provider, ModelCatalog> | null;
  boards: Board[];
  tasks: Task[];
  boardSync: Record<BoardId, BoardSync>;
  taskTime: Record<TaskId, TaskTime>;
  taskConnections: Record<'linear' | 'cronospark', TaskConnectionState>;
  // Task screens only: the board each block shows, and stages the owner just chose that the snapshot has not confirmed yet.
  boardPick: Record<string, BoardId>;
  stageHold: StageHolds;
  // The desk a task card in hand is over, and what dropping it there would do. Null when it is over anything else.
  aim: Aim | null;
  logs: Record<string, LogLine[]>;
  // Chat panel: the request whose chain is open (null is the person's own thread), whether the composer targets the PO, and the details view.
  chatSub: MessageId | null;
  chatToPo: boolean;
  chatDetails: boolean;
  pending: PendingPost[];
  // Older messages loaded by `load_history`, per conversation.
  history: Record<string, { messages: Message[]; hasMore: boolean }>;
  // The mailroom's live state, and the bubble each employee is writing right now.
  mail: MailView;
  streams: Record<string, { text: string; replyingTo: string | null; at: number }>;
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
  nearTaskBoard: BlockId | null;
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
  building: null,
  buildingRev: 0,
  story: 0,
  avatarFloors: {},
  pickedItem: null,
  build: null,
  buildCursor: { readout: null, verdict: null, hover: null },
  harnesses: null,
  meetingDoor: 'open',
  catalogs: null,
  boards: [],
  tasks: [],
  boardSync: {},
  taskTime: {},
  taskConnections: { linear: { kind: 'needs_auth' }, cronospark: { kind: 'needs_auth' } },
  boardPick: {},
  stageHold: {},
  aim: null,
  logs: {},
  chatSub: null,
  chatToPo: false,
  chatDetails: false,
  pending: [],
  history: {},
  mail: emptyMailView(),
  streams: {},
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
  nearTaskBoard: null,
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

export const toggleCamera = () => setSetting('camera', get().camera === 'iso' ? 'first' : 'iso');

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

// Test-only: window.office is frozen by the context bridge, so a test that must read what the UI sends taps it here.
export const sendTap: { fn: ((m: ClientMessage) => void) | null } = { fn: null };

export function send(m: ClientMessage) {
  if (m.type === 'post') set((s) => ({ pending: [...s.pending, { clientId: m.clientId, to: m.to, text: m.text, as: m.as, at: Date.now() }] }));
  if (sendTap.fn) sendTap.fn(m);
  else window.office.send(m);
}

// A new conversation starts from the person's own thread, aimed at them.
useStore.subscribe((s, prev) => {
  if (s.selectedId !== prev.selectedId && (s.chatSub || s.chatToPo || s.chatDetails)) set({ chatSub: null, chatToPo: false, chatDetails: false });
});
