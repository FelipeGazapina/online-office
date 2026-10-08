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
import type { AgentStage } from '../../shared/tasks.ts';
import { logger } from './debug.ts';
import type { MailTools } from './mail-tools.ts';
import type { Notebook } from './memory.ts';

// What one employee's tools can reach. The office builds it from the employee's own session, so a tool call
// can only ever touch that employee's card, that employee's block and that employee's notebook.
export type EmployeeTools = {
  ask(body: QuestionBody, signal?: AbortSignal): Promise<string>;
  drawDiagram(title: string, mermaid: string): void;
  openBoard(title: string, target: string): Promise<void>;
  // Moves the board card of a task this employee is on. Answers with how it went, refusals included.
  moveTask(a: { to: AgentStage; reason: string; task?: string }): unknown;
  // Asks to give a task to a teammate. Answers with the proposal, or with the refusal.
  handoffTask(a: { to: string; reason: string; task?: string; from?: string }): unknown;
  // Answers a handoff that waits on this employee, or withdraws one they asked for.
  answerHandoff(a: { id: string; answer: 'accept' | 'decline' | 'withdraw'; reason?: string }): unknown;
  mail: MailTools;
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
          "Walk to the boss's desk and ask a short question out loud only for a material product, scope, or priority decision that cannot be answered by inspecting code, docs, tests, or running the app. Never ask for an observable fact. Include the evidence you have and 2 to 4 concrete options with tradeoffs when a decision is needed. If the meeting-room door is closed, the owner is unavailable: choose a safe contextual option or continue parallel work and ask again later. Returns the boss's answer or that do-not-disturb guidance.",
        inputSchema: {
          question: z.string().min(1).max(2000).describe('A material decision question, with brief evidence when useful; do not ask about facts that can be observed'),
          options: z.array(z.string().max(200)).max(4).optional().describe('2 to 4 concrete options with tradeoffs for a genuine decision'),
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

    const OUTCOME = z.enum(['done', 'blocked', 'failed', 'declined', 'cancelled']);
    const { mail } = tools;
    const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, body: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal) => unknown | Promise<unknown>) => {
      const schema = z.object(shape);
      return server.registerTool(name, { description, inputSchema: schema.shape as z.ZodRawShape }, (args, extra) =>
        run(name, extra, async (signal) => json(await body(schema.parse(args), signal))),
      );
    };

    tool('team', 'List the people on your project block: name, role, state, how many messages wait for them, and what they are doing now. Look before you delegate.', {}, () => mail.team());

    tool(
      'message',
      'Say something to a teammate or to the owner. Use it FIRST in every turn that serves a request: one short acknowledgement ("On it. I will split this into the API and the UI.") before you start work. No reply is owed. "to" is a name, "po" or "owner".',
      { to: z.string().min(1).max(120), text: z.string().min(1).max(4000) },
      (a) => mail.message(a),
    );

    tool(
      'request',
      'Ask a teammate to do a piece of work, or for help. A busy teammate queues it: busy is not an error. Their result comes back to you as a reply message when you next wake, or through awaitReplies. Split work along pieces that can be verified on their own, and write a concrete bar for each. intent "help" is for a quick question to a peer.',
      {
        to: z.string().min(1).max(120).describe('A name, or "po"'),
        text: z.string().min(1).max(8000),
        title: z.string().max(80).optional().describe('A short title for the piece, shown on the card'),
        intent: z.enum(['work', 'help']).optional(),
        bar: z.array(z.string().max(500)).max(12).optional().describe('What done looks like, one checkable line each'),
        key: z.string().max(120).optional().describe('Repeating a call with the same key does not post twice'),
      },
      (a) => mail.request(a),
    );

    tool(
      'requestGauntlet',
      'Run a gauntlet loop on a piece that has a concrete bar. The office asks the builder, then shows ONLY the artifact and the bar to a different critic, who returns a pass or fail verdict. Findings go back to the builder until the critic passes or maxRounds runs out. You get one reply when it settles.',
      {
        piece: z.string().min(1).max(8000).describe('What the builder must make'),
        bar: z.array(z.string().max(500)).min(1).max(12),
        builder: z.string().min(1).max(120),
        critic: z.string().min(1).max(120).describe('Must be a different person from the builder'),
        maxRounds: z.number().int().min(1).max(10).optional(),
        key: z.string().max(120).optional(),
      },
      (a) => mail.requestGauntlet(a),
    );

    tool(
      'reply',
      'Settle a request you were given, with its result. Finish the work completely first. A done reply to a work request must list artifact: paths relative to the block folder that you wrote or edited since the request arrived, or a commit sha. The office checks that each exists and changed, and refuses done otherwise. If you are still waiting on someone, do not settle: awaitReplies, or end your turn and the last reply wakes you. If you end your turn without calling reply, the office settles from the folder: done when your turn left changes, blocked when it left none. A critic reviewing an artifact must send a verdict.',
      {
        requestId: z.string().min(1).max(80),
        outcome: OUTCOME,
        text: z.string().min(1).max(8000),
        artifact: z.array(z.string().max(500)).max(20).optional(),
        verdict: z.object({ pass: z.boolean(), findings: z.array(z.string().max(1000)).max(20) }).optional(),
      },
      (a) => mail.reply(a),
    );

    tool(
      'awaitReplies',
      'Wait for replies to requests you made. Returns when a listed reply arrives, or any other message arrives, or the timeout passes (an empty list). Use it when you cannot go on without the answer; otherwise end your turn and the reply will wake you.',
      {
        ids: z.array(z.string().max(80)).max(20).optional(),
        mode: z.enum(['any', 'all']).optional(),
        timeoutSec: z.number().min(1).max(600).optional(),
      },
      (a, signal) => mail.awaitReplies(a, signal),
    );

    tool(
      'moveTask',
      'Move the board card of a task you are on. to "review": your work is ready for the owner to look at. to "done": the task is finished and checked, and every piece you handed out is back. to "doing": you pick it up again. Say why in one sentence, because the owner reads it in the task log. The office refuses when the task is not yours, when the owner put the card where it is, while another request of the task is still open, or (for done) while its pull request is not merged; the refusal says why. Moving a card to where it already is does nothing.',
      {
        to: z.enum(['doing', 'review', 'done']),
        reason: z.string().trim().min(1).max(500).describe('One sentence for the owner: why the card moves'),
        task: z.string().max(200).optional().describe('The task title or id. Leave it out when you hold the request of one task.'),
      },
      (a) => tools.moveTask(a),
    );

    tool(
      'handoffTask',
      'Two people must agree before a task changes hands: the person on it and the PO. Giving your own task away, the PO answers. As the PO, the person on the task answers, and may decline. Use this tool to ask, naming a teammate of your block in to. A card changes hands only through this tool and answerHandoff: saying yes in a message changes nothing. It answers with an id, and the one who must agree is woken by a message that carries it. When you ask to give your own task away, you stop working on it now: end your turn, and if it stays with you it comes back as a new request. Accepting cancels the giver\'s open requests of the task and the pieces they handed out. As the PO, name from when more than one person is on the task, your own part included. Asking for the same handoff again returns the open one.',
      {
        to: z.string().min(1).max(120).describe('A name, or "po"'),
        reason: z.string().trim().min(1).max(500).describe('One sentence: why this person should have it'),
        task: z.string().max(200).optional().describe('The task title or id. Leave it out when you hold the request of one task.'),
        from: z.string().max(120).optional().describe('Who gives it away. Only the PO names someone else; leave it out for your own part.'),
      },
      (a) => tools.handoffTask(a),
    );

    tool(
      'answerHandoff',
      'Answer a handoff that waits on you. The id is in the message you were sent. Answer before this turn ends. If you do not, the office reminds you once, and drops the handoff if your next turn also ends without an answer. accept: the task changes hands now, the giver\'s open requests of it and the pieces they handed out are cancelled, and the receiver gets a new request. decline: the task stays where it is; a giver who stepped off gets it back as a new request. withdraw: take back a handoff you asked for. Answering the same way again is fine; a different answer to one that already ended is told how it ended.',
      {
        id: z.string().min(1).max(80),
        answer: z.enum(['accept', 'decline', 'withdraw']),
        reason: z.string().max(500).optional().describe('One sentence for the other person, and for the task log'),
      },
      (a) => tools.answerHandoff(a),
    );

    tool('inbox', 'Read messages that arrived while you worked. peek keeps them unread.', { peek: z.boolean().optional() }, (a) => mail.inbox(a));

    tool('cancelRequest', 'Cancel a request you made that is not settled yet.', { id: z.string().min(1).max(80) }, (a) => mail.cancelRequest(a));

    if (mail.hireTeammate) {
      const { hireTeammate } = mail;
      tool(
        'hireTeammate',
        'For the block PO only. Hire one more employee into this block when the team is too short for the work. Hire only when the existing team cannot take the pieces: queueing work on a busy teammate is fine. Repeating a call with the same key hires once.',
        { key: z.string().min(1).max(120), name: z.string().max(60).optional(), brief: z.string().max(2000).optional() },
        (a) => hireTeammate(a),
      );
    }

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
