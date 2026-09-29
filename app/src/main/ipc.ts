import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IPC,
  type BlockId,
  type ClientMessage,
  type EmployeeId,
  type HarnessStatus,
  type MeetingDoor,
  type ModelId,
  type Provider,
  type QuestionId,
  type ServerMessage,
} from '../shared/protocol.ts';
import { Office, OfficeError, type OfficeServices } from './office/company.ts';

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
  z.object({ kind: z.literal('tool'), name: z.string().min(1) }),
]);

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hire'), provider, blockId, name: z.string().optional(), model: modelId.optional() }),
  z.object({ type: z.literal('fire'), employeeId }),
  z.object({ type: z.literal('create_block'), cwd: z.string().min(1), name: z.string().min(1).optional() }),
  z.object({
    type: z.literal('update_block'),
    blockId,
    name: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('assign'), employeeId, task: z.string().min(1) }),
  z.object({ type: z.literal('answer'), employeeId, questionId, text: z.string(), always: z.boolean().optional() }),
  z.object({ type: z.literal('interject'), employeeId, text: z.string().min(1), style: z.enum(['next', 'now']) }),
  z.object({ type: z.literal('meeting_door'), state: meetingDoor }),
  z.object({ type: z.literal('load_models'), provider }),
  z.object({ type: z.literal('set_model'), employeeId, model: modelId }),
  z.object({ type: z.literal('set_permissions'), employeeId, mode: permissionMode }),
  z.object({ type: z.literal('remove_allow_rule'), employeeId, rule: allowRule }),
  z.object({ type: z.literal('fresh_session'), employeeId }),
  z.object({ type: z.literal('reset_company') }),
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
      said: (employeeId, text) => emit({ type: 'said', employeeId, text }),
      log: (employeeId, line, at) => emit({ type: 'log', employeeId, line, at }),
    },
    services,
  );

  // Anything that is not our own window (a frame that navigated away, a webview) gets nothing.
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === window()?.webContents;

  ipcMain.handle(IPC.snapshot, (e) => {
    if (!trusted(e)) throw new Error('Untrusted sender');
    return office.snapshot();
  });

  ipcMain.on(IPC.send, (e, raw: unknown) => {
    if (!trusted(e)) return;
    const parsed = clientMessage.safeParse(raw);
    if (!parsed.success) return emit({ type: 'error', message: `Bad message: ${z.prettifyError(parsed.error)}` });
    if (process.env.OFFICE_DEBUG) console.log('[ipc]', JSON.stringify(parsed.data).slice(0, 200));
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

  return { shutdown: () => office.shutdown() };
}
