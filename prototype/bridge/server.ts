import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  BRIDGE_PORT,
  type BlockId,
  type ClientMessage,
  type EmployeeId,
  type QuestionId,
  type ServerMessage,
} from '../shared/protocol.ts';
import { Office, OfficeError } from './company.ts';

// The one place untrusted input becomes a ClientMessage. Ids are opaque strings to the client.
const employeeId = z.string().min(1).transform((s) => s as EmployeeId);
const blockId = z.string().min(1).transform((s) => s as BlockId);
const questionId = z.string().min(1).transform((s) => s as QuestionId);
const provider = z.enum(['claude-code', 'codex', 'cursor', 'grok']);

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hire'), provider, blockId, name: z.string().optional() }),
  z.object({ type: z.literal('fire'), employeeId }),
  z.object({ type: z.literal('create_block'), name: z.string().min(1), cwd: z.string().min(1).optional() }),
  z.object({
    type: z.literal('update_block'),
    blockId,
    name: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('assign'), employeeId, task: z.string().min(1) }),
  z.object({ type: z.literal('answer'), employeeId, questionId, text: z.string() }),
  z.object({ type: z.literal('interject'), employeeId, text: z.string().min(1), style: z.enum(['next', 'now']) }),
  z.object({ type: z.literal('reset_company') }),
]);
// Compile-time proof the schema and the contract agree in both directions.
type Parsed = z.infer<typeof clientMessage>;
const _schemaMatchesContract: [Parsed] extends [ClientMessage] ? ([ClientMessage] extends [Parsed] ? true : never) : never = true;
void _schemaMatchesContract;

const wss = new WebSocketServer({ port: BRIDGE_PORT });

const send = (ws: WebSocket, msg: ServerMessage) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const broadcast = (msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(data);
};

let timer: NodeJS.Timeout | undefined;
const office = new Office({
  // State is tiny, so every change ships a full snapshot, coalesced to one per 50ms.
  changed() {
    timer ??= setTimeout(() => {
      timer = undefined;
      broadcast({ type: 'snapshot', company: office.snapshot() });
    }, 50);
  },
  said: (employeeId, text) => broadcast({ type: 'said', employeeId, text }),
  log: (employeeId, line, at) => broadcast({ type: 'log', employeeId, line, at }),
});

wss.on('connection', (ws) => {
  send(ws, { type: 'snapshot', company: office.snapshot() });
  ws.on('message', (data) => {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Message is not valid JSON' });
    }
    const parsed = clientMessage.safeParse(json);
    if (!parsed.success) {
      return send(ws, { type: 'error', message: `Bad message: ${z.prettifyError(parsed.error)}` });
    }
    try {
      office.handle(parsed.data);
    } catch (e) {
      if (!(e instanceof OfficeError)) console.error(e);
      send(ws, { type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
  ws.on('error', (e) => console.error('ws error', e));
});

const shutdown = () => {
  office.shutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`Bridge listening on ws://localhost:${BRIDGE_PORT} (${office.snapshot().name}, level ${office.snapshot().level})`);
