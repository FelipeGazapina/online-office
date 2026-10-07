import { app, dialog, globalShortcut, ipcMain, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IPC,
  type BlockId,
  type ClientMessage,
  type EmployeeId,
  type HarnessStatus,
  type LinearFilters,
  type MeetingDoor,
  type ModelId,
  type Provider,
  type QuestionId,
  type ServerMessage,
  type TaskBoardSource,
  type TaskProvider,
} from '../shared/protocol.ts';
import { PRIORITIES, type BoardId, type BoardSpec, type Priority, type TaskId, type TaskStage } from '../shared/tasks.ts';
import type { BuildOp, Item, ItemId, WallSeg } from '../shared/space/types.ts';
import type { ConvoKey, MessageId } from '../shared/mail.ts';
import { Office, type OfficeServices } from './office/company.ts';
import { OfficeError } from './office/error.ts';

// The one place untrusted input becomes a ClientMessage. Ids are opaque strings to the renderer.
const employeeId = z.string().min(1).transform((s) => s as EmployeeId);
const blockId = z.string().min(1).transform((s) => s as BlockId);
const questionId = z.string().min(1).transform((s) => s as QuestionId);
const modelId = z.string().min(1).transform((s) => s as ModelId);
const provider = z.enum(['claude-code', 'codex', 'hermes']);
const meetingDoor = z.enum(['open', 'closed']) satisfies z.ZodType<MeetingDoor>;
const permissionMode = z.enum(['inherit', 'ask', 'auto', 'yolo']);
const allowRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), prefix: z.string().min(1) }),
  z.object({ kind: z.literal('exact'), command: z.string().min(1) }),
  z.object({ kind: z.literal('tool'), name: z.string().min(1) }),
]);
const taskProvider = z.enum(['linear', 'cronospark']) satisfies z.ZodType<TaskProvider>;
const boardId = z.string().min(1).transform((s) => s as BoardId);
const taskId = z.string().min(1).transform((s) => s as TaskId);
const taskStage = z.enum(['todo', 'doing', 'review', 'done']) satisfies z.ZodType<TaskStage>;
const priority = z.enum(PRIORITIES) satisfies z.ZodType<Priority>;
const linearFilters = z.object({
  assignee: z.union([z.enum(['anyone', 'me']), z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) })]),
  cycle: z.enum(['any', 'current']),
  limit: z.union([z.literal(50), z.literal(200)]),
}) satisfies z.ZodType<LinearFilters>;
const sourceProject = z.string().min(1).max(200);
const sourceLabel = z.string().max(120).optional();
// CronoSpark's tool has no filters to offer, so a filter sent along with its source is refused here instead of dropped.
const taskSources = z
  .array(
    z.discriminatedUnion('provider', [
      z.strictObject({ provider: z.literal('cronospark'), projectId: sourceProject, label: sourceLabel }),
      z.object({ provider: z.literal('linear'), projectId: sourceProject, label: sourceLabel, filters: linearFilters.optional() }),
    ]),
  )
  .max(8) satisfies z.ZodType<TaskBoardSource[]>;
// A quick board is strict: a source sent along with one is refused here instead of dropped.
const boardSpec = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('quick') }),
  z.object({ kind: z.enum(['feature', 'bug']), sources: taskSources }),
]) satisfies z.ZodType<BoardSpec>;

const tile = z.number().int().min(-4096).max(4096);
const rot = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const wallDir = z.enum(['e', 's', 'sd', 'nd']);
const wallRef = z.object({ x: tile, z: tile, d: wallDir });
const wallSeg: z.ZodType<WallSeg> = z.object({ x: tile, z: tile, d: wallDir, style: z.number().int().min(0).max(255), open: z.enum(['door', 'window', 'arch']).optional() });
const itemIdSchema = z.string().min(1).max(200).transform((s) => s as ItemId);
const itemBase = {
  id: itemIdSchema,
  def: z.string().min(1).max(60),
  rot,
  blockId: z.string().min(1).optional(),
  tint: z.number().int().min(0).max(0xffffff).optional(),
};
const unit = z.number().int().min(-1024).max(1024);
const item: z.ZodType<Item> = z.union([z.object({ ...itemBase, x: tile, z: tile }), z.object({ ...itemBase, on: itemIdSchema, u: unit, v: unit })]);
const lot = z.object({ x0: tile, z0: tile, w: z.number().int().min(1).max(64), h: z.number().int().min(1).max(64) });
const MANY = 4096;
const buildOp: z.ZodType<BuildOp> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('lot'), lot }),
  z.object({ t: z.literal('stories'), count: z.number().int().min(1).max(4) }),
  z.object({ t: z.literal('walls'), story: z.number().int().min(0).max(3), put: z.array(wallSeg).max(MANY), del: z.array(wallRef).max(MANY) }),
  z.object({
    t: z.literal('floor'),
    story: z.number().int().min(0).max(3),
    cells: z.array(z.object({ x: tile, z: tile, half: z.union([z.literal(0), z.literal(1)]), paint: z.number().int().min(0).max(255) })).max(MANY),
  }),
  z.object({ t: z.literal('items'), story: z.number().int().min(0).max(3), put: z.array(item).max(MANY), del: z.array(itemIdSchema).max(MANY) }),
]);

const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hire'),
    provider,
    blockId,
    name: z.string().optional(),
    model: modelId.optional(),
    role: z.enum(['employee', 'orchestrator']).optional(),
    bypassLimit: z.boolean().optional(),
    deskId: itemIdSchema.optional(),
    taskId: taskId.optional(),
  }),
  z.object({ type: z.literal('fire'), employeeId }),
  z.object({ type: z.literal('create_block'), cwd: z.string().min(1), name: z.string().min(1).optional(), githubRepo: z.string().url().optional() }),
  z.object({
    type: z.literal('update_block'),
    blockId,
    name: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    githubRepo: z.string().url().optional(),
  }),
  z.object({ type: z.literal('remove_block'), blockId }),
  z.object({ type: z.literal('configure_linear_board'), blockId, url: z.string().url().max(1000) }),
  z.object({ type: z.literal('create_board'), blockId, name: z.string().min(1).max(120), spec: boardSpec }),
  z.object({ type: z.literal('update_board'), boardId, name: z.string().min(1).max(120).optional(), sources: taskSources.optional(), collapsed: z.array(taskStage).max(4).optional() }),
  z.object({ type: z.literal('delete_board'), boardId }),
  z.object({ type: z.literal('refresh_board'), boardId }),
  z.object({ type: z.literal('create_task'), boardId, title: z.string().min(1).max(500), notes: z.string().max(20_000).optional(), stage: taskStage.optional(), assignee: employeeId.optional(), priority: priority.optional() }),
  z.object({ type: z.literal('update_task'), taskId, title: z.string().min(1).max(500).optional(), notes: z.string().max(20_000).optional(), stage: taskStage.optional(), priority: priority.nullable().optional() }),
  z.object({ type: z.literal('delete_task'), taskId }),
  z.object({ type: z.literal('assign_task'), taskId, employeeId }),
  z.object({ type: z.literal('send_hours'), taskId }),
  z.object({ type: z.literal('connect_task_provider'), provider: taskProvider }),
  z.object({ type: z.literal('load_linear_people') }),
  z.object({ type: z.literal('configure_task_provider'), provider: z.literal('cronospark'), apiKey: z.string().max(2000), userId: z.string().max(200) }),
  z.object({
    type: z.literal('post'),
    to: z.string().min(1).max(200),
    blockId: blockId.optional(),
    clientId: z.string().min(1).max(200),
    as: z.enum(['request', 'say']),
    text: z.string().min(1).max(20_000),
    urgency: z.enum(['queue', 'next', 'now']).optional(),
  }),
  z.object({ type: z.literal('cancel_message'), messageId: z.string().min(1).transform((s) => s as MessageId) }),
  z.object({ type: z.literal('load_history'), convo: z.string().regex(/^dm:.+/).transform((s) => s as ConvoKey), before: z.string().min(1).transform((s) => s as MessageId).optional(), limit: z.number().int().min(1).max(200) }),
  z.object({ type: z.literal('answer'), employeeId, questionId, text: z.string(), always: z.boolean().optional() }),
  z.object({ type: z.literal('meeting_door'), state: meetingDoor }),
  z.object({ type: z.literal('load_models'), provider }),
  z.object({ type: z.literal('set_model'), employeeId, model: modelId }),
  z.object({ type: z.literal('set_permissions'), employeeId, mode: permissionMode }),
  z.object({ type: z.literal('remove_allow_rule'), employeeId, rule: allowRule }),
  z.object({ type: z.literal('fresh_session'), employeeId }),
  z.object({ type: z.literal('reset_company') }),
  z.object({ type: z.literal('build'), ops: z.array(buildOp).min(1).max(64) }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
]);
// Compile-time proof the schema and the contract agree in both directions.
type Parsed = z.infer<typeof clientMessage>;
const _schemaMatchesContract: [Parsed] extends [ClientMessage] ? ([ClientMessage] extends [Parsed] ? true : never) : never = true;
void _schemaMatchesContract;

const folderPath = z.string().min(1);

type Options = {
  dataFile: string;
  harnesses: Record<Provider, HarnessStatus>;
  window: () => BrowserWindow | null;
  services: OfficeServices;
};

// Owns the Office and everything that crosses the process boundary. Register once per app run, not per window.
export function startOffice({ dataFile, harnesses, window, services }: Options) {
  const emit = (msg: ServerMessage) => {
    const win = window();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.event, msg);
  };

  let timer: NodeJS.Timeout | undefined;
  const office = new Office(
    dataFile,
    harnesses,
    {
      // State is tiny, so every change ships a full snapshot, coalesced to one per 50ms.
      changed() {
        timer ??= setTimeout(() => {
          timer = undefined;
          emit(office.snapshot());
        }, 50);
      },
      building: (building, rev) => emit({ type: 'building', building, rev }),
      rejected: (violations) => emit({ type: 'build_rejected', violations }),
      said: (employeeId, text) => emit({ type: 'said', employeeId, text }),
      log: (employeeId, line, at) => emit({ type: 'log', employeeId, line, at }),
      // Mail and live tokens are sparse and the owner is waiting on them, so they skip the coalescer.
      mail: (view) => emit({ type: 'mail', view }),
      stream: (employeeId, replyingTo, delta, done) => emit({ type: 'stream', employeeId, replyingTo, delta, ...(done ? { done } : {}) }),
      history: (convo, messages, hasMore) => emit({ type: 'history', convo, messages, hasMore }),
      error: (message) => emit({ type: 'error', message }),
    },
    services,
  );

  // Anything that is not our own window (a frame that navigated away, a webview) gets nothing.
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === window()?.webContents;

  ipcMain.handle(IPC.snapshot, (e) => {
    if (!trusted(e)) throw new Error('Untrusted sender');
    return office.snapshot();
  });

  ipcMain.handle(IPC.building, (e) => {
    if (!trusted(e)) throw new Error('Untrusted sender');
    return office.buildingState();
  });

  ipcMain.on(IPC.send, (e, raw: unknown) => {
    if (!trusted(e)) return;
    const parsed = clientMessage.safeParse(raw);
    if (!parsed.success) return emit({ type: 'error', message: `Bad message: ${z.prettifyError(parsed.error)}` });
    if (process.env.OFFICE_DEBUG) {
      const debugMessage = parsed.data.type === 'configure_task_provider' ? { ...parsed.data, apiKey: '<redacted>' } : parsed.data;
      console.log('[ipc]', JSON.stringify(debugMessage).slice(0, 200));
    }
    try {
      office.handle(parsed.data);
    } catch (err) {
      if (!(err instanceof OfficeError)) console.error(err);
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  ipcMain.handle(IPC.pickFolder, async (e): Promise<string | null> => {
    if (!trusted(e)) return null;
    // Tests cannot click a native dialog, so they name the folder up front.
    const preset = process.env.OFFICE_TEST_PICK_FOLDER;
    if (preset) return preset;
    const win = window();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.on(IPC.revealFolder, (e, raw: unknown) => {
    const path = folderPath.safeParse(raw);
    if (trusted(e) && path.success) shell.showItemInFolder(path.data);
  });

  let normalBounds: Electron.Rectangle | null = null;
  let portalWasMaximized = false;
  let portalWasFullScreen = false;
  let portalFullScreenGuard: (() => void) | null = null;
  let portalActive = false;
  // A bare F remains available to the renderer while the portal is focused. Once a native app
  // takes focus, this modifier shortcut returns to the office without stealing the letter F from text input.
  const portalShortcuts = ['CommandOrControl+Shift+O'];
  const unregisterPortalShortcuts = () => portalShortcuts.forEach((accelerator) => globalShortcut.unregister(accelerator));
  const restorePortal = (notify: boolean) => {
    unregisterPortalShortcuts();
    portalActive = false;
    const win = window();
    if (!win || win.isDestroyed()) return;
    if (portalFullScreenGuard) {
      win.removeListener('enter-full-screen', portalFullScreenGuard);
      portalFullScreenGuard = null;
    }
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.setContentProtection(false);
    win.setAlwaysOnTop(false);
    if (win.isMaximized() && !portalWasMaximized) win.unmaximize();
    if (normalBounds) {
      win.setBounds(normalBounds, true);
      normalBounds = null;
    }
    if (portalWasMaximized && !win.isMaximized()) win.maximize();
    if (portalWasFullScreen) win.setFullScreen(true);
    portalWasMaximized = false;
    portalWasFullScreen = false;
    if (notify) win.webContents.send(IPC.portalExit);
  };
  ipcMain.on(IPC.portalEnter, (e) => {
    if (!trusted(e)) return;
    const win = window();
    if (!win || win.isDestroyed()) return;
    if (portalActive) return;
    portalWasFullScreen = win.isFullScreen();
    portalWasMaximized = !portalWasFullScreen && win.isMaximized();
    if (portalWasFullScreen) win.setFullScreen(false);
    if (!portalWasFullScreen && !portalWasMaximized) normalBounds ??= win.getBounds();
    portalActive = true;
    portalFullScreenGuard = () => {
      if (portalActive && win.isFullScreen()) {
        win.setFullScreen(false);
        win.maximize();
      }
    };
    win.on('enter-full-screen', portalFullScreenGuard);
    win.setAlwaysOnTop(true, 'screen-saver');
    // A native fullscreen window lives in its own Space. Leave that Space while the portal is
    // active, then fill the owner's current Space by maximizing in place.
    if (!portalWasMaximized) win.maximize();
    // Hide this layer from the screen capture to avoid a hall-of-mirrors effect. The real desktop
    // underneath remains visible in the video and receives the user's mouse and keyboard events.
    win.setContentProtection(true);
    if (!process.env.OFFICE_TEST_RUN) {
      win.setIgnoreMouseEvents(true, { forward: true });
      // The mirror is click-through by design. The modifier shortcut remains available after a
      // native app takes focus without consuming ordinary text input.
      for (const accelerator of portalShortcuts) globalShortcut.register(accelerator, () => restorePortal(true));
    }
  });
  ipcMain.on(IPC.portalLeave, (e) => {
    if (!trusted(e)) return;
    restorePortal(false);
  });
  ipcMain.on(IPC.portalOpenHome, (e) => {
    if (trusted(e)) void shell.openPath(app.getPath('home'));
  });
  ipcMain.on(IPC.portalOpenTerminal, (e) => {
    if (trusted(e)) void shell.openPath('/System/Applications/Utilities/Terminal.app');
  });
  ipcMain.on(IPC.portalOpenSlack, (e) => {
    if (!trusted(e)) return;
    if (process.platform === 'darwin') {
      void shell.openPath('/Applications/Slack.app');
    } else {
      void shell.openExternal('slack://open');
    }
  });

  return { shutdown: () => { unregisterPortalShortcuts(); office.shutdown(); } };
}
