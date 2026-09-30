// The office's own MCP server, one for every harness. Streamable HTTP on 127.0.0.1, one URL per employee.
// Plain Node with no electron import, so the check script can run it without the app.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EmployeeId, QuestionBody } from '../../shared/protocol.ts';
import { logger } from './debug.ts';
import type { Notebook } from './memory.ts';

// What one employee's tools can reach. The office builds it from the employee's own session, so a tool call
// can only ever touch that employee's card, that employee's block and that employee's notebook.
export type EmployeeTools = {
  ask(body: QuestionBody, signal?: AbortSignal): Promise<string>;
  drawDiagram(title: string, mermaid: string): void;
  openBoard(title: string, target: string): Promise<void>;
  delegateToTeammate(target: string | undefined, task: string): Promise<string>;
  memory: Notebook;
};

export type OfficeMcp = {
  readonly port: number;
  // Mints the URL an employee's harness connects to. The URL is the identity. A second call for the same employee
  // replaces the first: the old URL stops working and its calls are cancelled.
  attach(employeeId: EmployeeId, tools: EmployeeTools): string;
  detach(employeeId: EmployeeId): void;
  close(): Promise<void>;
};

const NAME = 'office';
const MAX_BODY_BYTES = 1024 * 1024;

const debug = logger('mcp');

// One MCP session, which is one connection from one harness. An employee can have several.
type Session = {
  transport: StreamableHTTPServerTransport;
  // The HTTP layer creates an entry when a tools/call arrives and aborts it if the client drops the request.
  // The tool call picks it up by request id, so there is no window where a dropped call is missed.
  calls: Map<string, AbortController>;
};

type Endpoint = { employeeId: EmployeeId; tools: EmployeeTools; sessions: Map<string, Session> };

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function reply(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

// The ids of the tool calls a POST carries. A client may batch.
const toolCallIds = (body: unknown): string[] =>
  (Array.isArray(body) ? body : [body])
    .filter((m): m is { method: string; id: string | number } => !!m && m.method === 'tools/call' && m.id !== undefined)
    .map((m) => String(m.id));

export async function startOfficeMcp(): Promise<OfficeMcp> {
  const endpoints = new Map<string, Endpoint>();
  const tokens = new Map<EmployeeId, string>();
  let port = 0;

  // Runs a tool body with a signal that fires when the harness cancels the call, the client drops the request, or the session closes.
  async function traced<T>(endpoint: Endpoint, session: Session, tool: string, extra: { signal: AbortSignal; requestId: string | number }, body: (signal: AbortSignal) => Promise<T>) {
    const dropped = session.calls.get(String(extra.requestId));
    const signal = dropped ? AbortSignal.any([extra.signal, dropped.signal]) : extra.signal;
    const t0 = Date.now();
    debug(`${endpoint.employeeId} ${tool} over http`);
    try {
      return await body(signal);
    } finally {
      debug(`${endpoint.employeeId} ${tool} ${signal.aborted ? 'aborted' : 'done'} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  function buildServer(endpoint: Endpoint, session: Session): McpServer {
    const { tools } = endpoint;
    const server = new McpServer({ name: NAME, version: '0.1.0' });
    const run = <T>(tool: string, extra: { signal: AbortSignal; requestId: string | number }, body: (signal: AbortSignal) => Promise<T>) =>
      traced(endpoint, session, tool, extra, body);

    server.registerTool(
      'ask_owner',
      {
        description:
          "Walk to the boss's desk and ask a question out loud. Use it whenever you need a decision or are unsure about direction. If the meeting-room door is closed, the owner is unavailable: choose a safe contextual option or continue parallel work and ask again later. Returns the boss's answer or that do-not-disturb guidance.",
        inputSchema: {
          question: z.string().min(1).max(2000).describe('A short question that is easy to say aloud'),
          options: z.array(z.string().max(200)).max(4).optional().describe('2 to 4 short answers the boss can pick from'),
        },
      },
      (args, extra) =>
        run('ask_owner', extra, async (signal) =>
          text(await tools.ask({ kind: 'ask', text: args.question, ...(args.options?.length ? { options: args.options } : {}) }, signal)),
        ),
    );

    server.registerTool(
      'draw_diagram',
      {
        description: 'Draw a mermaid diagram on the team whiteboard so the boss and coworkers can see a design or plan.',
        inputSchema: {
          title: z.string().min(1).max(200).describe('Short title shown above the diagram'),
          mermaid: z.string().min(1).max(20_000).describe('Mermaid source, for example a flowchart'),
        },
      },
      (args, extra) =>
        run('draw_diagram', extra, async () => {
          tools.drawDiagram(args.title, args.mermaid);
          return text('Drawn on the whiteboard.');
        }),
    );

    server.registerTool(
      'open_board',
      {
        description: 'Show a website or a local HTML file on your project block board. Use an HTTP(S) URL (including localhost for running apps) or a path inside the project. Local HTML is a static snapshot; use a local web server URL for scripts and relative assets. The owner clicks the board to view it.',
        inputSchema: {
          title: z.string().min(1).max(200),
          target: z.string().min(1).max(4096).describe('HTTP(S) URL or project-relative HTML path'),
        },
      },
      (args, extra) => run('open_board', extra, async () => {
        await tools.openBoard(args.title, args.target);
        return text('Page placed on the block board. Click the board to view it.');
      }),
    );

    server.registerTool(
      'delegate_to_teammate',
      {
        description: 'For a block orchestrator only. Give a clear task to another employee on the same project block. Leave target empty to choose an idle teammate.',
        inputSchema: {
          target: z.string().max(120).optional().describe('Teammate name, or empty to choose an idle teammate'),
          task: z.string().min(1).max(4000).describe('The task to assign'),
        },
      },
      (args, extra) => run('delegate_to_teammate', extra, async () => text(await tools.delegateToTeammate(args.target, args.task))),
    );

    server.registerTool(
      'remember',
      {
        description:
          'Save one short fact to your notes, so you or your team can use it in a later session. scope "me" is for how you work with the boss, "block" is for facts every teammate on this project needs. ' +
          'The title is the fact itself in one line, 60 characters at most. The body is the detail, 500 characters at most. Saving an existing title updates it. ' +
          'Never save secrets, anything the code or git history already shows, or the state of a task in progress.',
        inputSchema: {
          scope: z.enum(['me', 'block']).describe('me: your own notebook. block: shared with everyone on this project.'),
          title: z.string().min(1).max(500).describe('The fact as a complete short sentence, for example "Release branch is release-teal"'),
          body: z.string().max(5000).describe('The detail a reader needs, for example "Tag each release vYYYY.MM.DD"'),
        },
      },
      (args, extra) =>
        run('remember', extra, async () => {
          const result = await tools.memory.remember(args.scope, args.title, args.body);
          return json(result, !result.ok);
        }),
    );

    server.registerTool(
      'recall',
      {
        description:
          'Look up your saved notes. Give a query to search titles and bodies and get up to 5 full notes. Leave the query empty to list every title. The titles you were given at the start are only a summary, so recall before relying on one.',
        inputSchema: {
          query: z.string().max(500).optional().describe('A few keywords'),
          scope: z.enum(['me', 'block', 'both']).optional().describe('Where to look. Default both.'),
        },
      },
      (args, extra) => run('recall', extra, async () => json(tools.memory.recall(args.query, args.scope ?? 'both'))),
    );

    server.registerTool(
      'forget',
      {
        description: 'Delete a note that is wrong or out of date. The id comes from recall or from a remember result.',
        inputSchema: {
          scope: z.enum(['me', 'block']).describe('Which notebook the note is in'),
          id: z.string().min(1).max(200).describe('The note id'),
        },
      },
      (args, extra) =>
        run('forget', extra, async () => {
          const result = await tools.memory.forget(args.scope, args.id);
          return json(result, !result.ok);
        }),
    );

    return server;
  }

  async function newSession(endpoint: Endpoint): Promise<Session> {
    const session: Session = {
      calls: new Map(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          endpoint.sessions.set(id, session);
        },
      }),
    };
    // Set before connect, which chains its own handler after this one.
    session.transport.onclose = () => {
      for (const call of session.calls.values()) call.abort();
      if (session.transport.sessionId) endpoint.sessions.delete(session.transport.sessionId);
    };
    await buildServer(endpoint, session).connect(session.transport);
    return session;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // A browser page cannot reach this server, and neither can a DNS name that resolves to it. Real MCP clients send neither.
    if (req.headers.origin !== undefined) return reply(res, 403, 'Origin not allowed');
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, 'Host not allowed');

    const token = /^\/mcp\/([0-9a-f]{64})$/.exec(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)?.[1];
    const endpoint = token ? endpoints.get(token) : undefined;
    if (!endpoint) return reply(res, 404, 'Not found');

    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'POST') {
      const body = await readJson(req);
      let session = typeof sessionId === 'string' ? endpoint.sessions.get(sessionId) : undefined;
      if (typeof sessionId === 'string' && !session) return reply(res, 404, 'Session not found');
      if (!session) {
        if (!isInitializeRequest(body)) return reply(res, 400, 'Missing Mcp-Session-Id header');
        session = await newSession(endpoint);
      }
      const ids = toolCallIds(body);
      const calls = ids.map((id) => [id, new AbortController()] as const);
      for (const [id, ctl] of calls) session.calls.set(id, ctl);
      const live = session;
      res.on('close', () => {
        for (const [id, ctl] of calls) {
          // Closed before we finished writing means the client gave up on the call.
          if (!res.writableFinished) ctl.abort();
          if (live.calls.get(id) === ctl) live.calls.delete(id);
        }
      });
      return session.transport.handleRequest(req, res, body);
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && typeof sessionId === 'string') {
      const session = endpoint.sessions.get(sessionId);
      if (!session) return reply(res, 404, 'Session not found');
      return session.transport.handleRequest(req, res);
    }
    // No stream and nothing to close without a session. Hermes probes with HEAD and GET before it initializes, and takes a 405.
    res.setHeader('allow', 'POST');
    return reply(res, 405, 'Method not allowed');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return reply(res, e.status, e.message);
      console.error('[mcp] request failed:', e);
      if (res.headersSent) res.end();
      else reply(res, 500, 'Internal error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
  debug(`listening on 127.0.0.1:${port}`);

  const detach = (employeeId: EmployeeId) => {
    const token = tokens.get(employeeId);
    if (!token) return;
    tokens.delete(employeeId);
    const endpoint = endpoints.get(token);
    endpoints.delete(token);
    for (const session of endpoint?.sessions.values() ?? []) {
      for (const call of session.calls.values()) call.abort();
      void session.transport.close();
    }
  };

  return {
    port,
    attach(employeeId, tools) {
      detach(employeeId);
      const token = randomBytes(32).toString('hex');
      tokens.set(employeeId, token);
      endpoints.set(token, { employeeId, tools, sessions: new Map() });
      return `http://127.0.0.1:${port}/mcp/${token}`;
    },
    detach,
    async close() {
      for (const employeeId of [...tokens.keys()]) detach(employeeId);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
