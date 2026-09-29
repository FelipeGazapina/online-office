// The one `codex app-server` process that every Codex employee shares, and the JSON-RPC over its stdio. Plain Node with no
// Electron import: the check scripts drive it with a scripted stand-in for the process.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { z } from 'zod';
import { logger } from '../debug.ts';
import {
  anything,
  parseEvent,
  parseFrame,
  parseRequest,
  readOwnerAuth,
  readOwnerRules,
  CodexSetupError,
  RpcError,
  type OwnerAuth,
  type RequestId,
  type ServerRequest,
  type ThreadEvent,
} from './codex-protocol.ts';

const debug = logger('codex');

// What the office needs of a child process. A real ChildProcess started with three pipes is one.
export interface Child {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

// The process died, or never started. Nothing answers a request after this.
export class ServerGone extends Error {}

// The app-server sends these all the time and the office reads none of them.
const QUIET = [
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/plan/delta',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/tokenUsage/updated',
  'thread/status/changed',
  'account/rateLimits/updated',
];

type Pending = { method: string; timer: NodeJS.Timeout; resolve(raw: unknown): void; reject(error: Error): void };

const CALL_TIMEOUT_MS = 30_000;
const STDERR_LINES = 20;

// One running app-server: its requests and answers, and what it says on its own.
export class CodexServer {
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly stderrTail: string[] = [];
  private readonly child: Child;
  private gone = false;
  // Set by close(), so the exit that follows is not taken for a crash.
  closing = false;

  onNotification: (method: string, params: unknown) => void = () => {};
  onRequest: (id: RequestId, method: string, params: unknown) => Promise<unknown> = () => Promise.reject(new RpcError(-32601, 'Nobody answers requests'));
  onExit: (reason: string) => void = () => {};

  constructor(child: Child) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        debug('stderr:', line);
        this.stderrTail.push(line.trim());
        if (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
      }
    });
    // A write to a process that is gone fails here. The exit event is what says why.
    child.stdin.on('error', () => {});
    child.once('error', (error) => this.finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Codex is not installed on this Mac' : `Codex could not start: ${error.message}`));
    child.once('exit', (code, signal) => this.finish(this.exitText(code, signal)));
  }

  private exitText(code: number | null, signal: NodeJS.Signals | null): string {
    const last = this.stderrTail.at(-1);
    return `Codex stopped (${signal ? `signal ${signal}` : `code ${code}`})${last ? `: ${last}` : ''}`;
  }

  private finish(reason: string) {
    if (this.gone) return;
    this.gone = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ServerGone(reason));
    }
    this.pending.clear();
    this.onExit(reason);
  }

  // One request, answered in the shape `schema` describes. The answer is untyped until it passes through it.
  call<S extends z.ZodType>(method: string, params: unknown, schema: S, timeoutMs = CALL_TIMEOUT_MS): Promise<z.infer<S>> {
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(new ServerGone('Codex is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} within ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        timer,
        reject,
        resolve: (raw) => {
          const parsed = schema.safeParse(raw);
          if (parsed.success) resolve(parsed.data);
          else reject(new Error(`Codex answered ${method} in a shape the office does not know: ${parsed.error.message}`));
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(frame: unknown) {
    if (!this.gone) this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private onLine(line: string) {
    const frame = parseFrame(line);
    if (!frame) return debug('not a frame:', line.slice(0, 200));
    switch (frame.kind) {
      case 'response':
      case 'failure': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.kind === 'response') p.resolve(frame.result);
        else p.reject(new RpcError(frame.code, frame.message));
        return;
      }
      case 'notification':
        try {
          this.onNotification(frame.method, frame.params);
        } catch (e) {
          debug(`handling ${frame.method} failed:`, e);
        }
        return;
      case 'request':
        Promise.resolve()
          .then(() => this.onRequest(frame.id, frame.method, frame.params))
          .then(
            (result) => this.write({ id: frame.id, result }),
            (e: unknown) => this.write({ id: frame.id, error: { code: e instanceof RpcError ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } }),
          );
        return;
    }
  }

  // Closing the pipe is what makes the app-server exit, and it takes the commands it started along. That is also what
  // happens when the whole app is killed, so a leftover process cannot outlive its parent. SIGTERM and SIGKILL are for one
  // that ignores the pipe.
  close() {
    this.closing = true;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    setTimeout(() => {
      if (!this.gone) this.child.kill('SIGKILL');
    }, 2000).unref();
  }
}

// A user of the server: one employee's session, or a one-off request such as the model list.
export interface CodexUser {
  // An event about a thread this user has routed.
  onEvent(event: ThreadEvent): void;
  // A request from the server about a thread this user has routed. What it resolves with is the answer.
  onRequest(id: RequestId, request: ServerRequest): Promise<unknown>;
  // The process died. Every thread that was loaded on it is gone until it is loaded again.
  serverLost(reason: string): void;
  // Something the owner should be told, from the pool itself.
  notice(line: string): void;
}

export type PoolOptions = {
  // Starts one app-server process.
  spawn(): Child;
  // The office's own CODEX_HOME.
  home: string;
  // The owner's, read and never written: his sign-in, and his rules for the sessions that follow his settings.
  ownerHome: string;
  ownerAuth?(): OwnerAuth;
};

const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

// Starts the shared app-server when someone first needs it, and closes it when the last one is done. If it dies it starts
// again for whoever asks next. It also owns what one process serves to all: the sign-in and which thread belongs to whom.
export class CodexPool {
  private readonly opts: PoolOptions;
  private server: CodexServer | undefined;
  private starting: Promise<CodexServer> | undefined;
  private readonly users = new Set<CodexUser>();
  private readonly routes = new Map<string, CodexUser>();
  private readonly exits: number[] = [];
  private lastExit = '';
  // The access token last handed to Codex, so a refresh that could only give the same one is refused.
  private handedOut = '';
  private rulesLock: Promise<unknown> = Promise.resolve();

  constructor(opts: PoolOptions) {
    this.opts = opts;
  }

  get ownerHome(): string {
    return this.opts.ownerHome;
  }

  // The running server, started if it was not. The caller holds it until `release`, and the server lives while anyone does.
  acquire(user: CodexUser): Promise<CodexServer> {
    this.users.add(user);
    if (this.server) return Promise.resolve(this.server);
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  release(user: CodexUser) {
    this.users.delete(user);
    for (const [thread, owner] of this.routes) if (owner === user) this.routes.delete(thread);
    if (!this.users.size) this.closeServer();
  }

  route(threadId: string, user: CodexUser) {
    this.routes.set(threadId, user);
  }

  unroute(threadId: string) {
    this.routes.delete(threadId);
  }

  async with<T>(use: (server: CodexServer) => Promise<T>): Promise<T> {
    const lease: CodexUser = {
      onEvent() {},
      onRequest: () => Promise.reject(new RpcError(-32601, 'Nothing here answers requests')),
      serverLost() {},
      notice() {},
    };
    try {
      return await use(await this.acquire(lease));
    } finally {
      this.release(lease);
    }
  }

  // Codex reads `rules/*.rules` when a thread starts and keeps them for that thread's life. The owner's rules go to the
  // threads that follow the owner's settings and to no other, so the folder holds them only while such a thread loads,
  // one load at a time. Left there, they would reach a subagent that another employee's thread spawns later.
  loadThread<T>(inherit: boolean, load: () => Promise<T>): Promise<T> {
    const file = join(this.opts.home, 'rules', 'owner.rules');
    const put = (text: string) => {
      if (text) {
        mkdirSync(join(this.opts.home, 'rules'), { recursive: true });
        writeFileSync(file, text);
      } else rmSync(file, { force: true });
    };
    const run = async () => {
      put(inherit ? readOwnerRules(this.opts.ownerHome) : '');
      try {
        return await load();
      } finally {
        put('');
      }
    };
    const result = this.rulesLock.then(run, run);
    this.rulesLock = result.catch(() => undefined);
    return result;
  }

  private readAuth(): OwnerAuth {
    return this.opts.ownerAuth ? this.opts.ownerAuth() : readOwnerAuth(this.opts.ownerHome);
  }

  private closeServer() {
    const server = this.server;
    this.server = undefined;
    server?.close();
  }

  private async start(): Promise<CodexServer> {
    const now = Date.now();
    while (this.exits.length && now - this.exits[0]! > CRASH_WINDOW_MS) this.exits.shift();
    if (this.exits.length >= MAX_CRASHES) throw new Error(`Codex keeps stopping. ${this.lastExit}`);
    const auth = this.readAuth();
    const server = new CodexServer(this.opts.spawn());
    server.onExit = (reason) => this.exited(server, reason);
    server.onNotification = (method, params) => {
      const event = parseEvent(method, params);
      if (event) this.routes.get(event.threadId)?.onEvent(event);
    };
    server.onRequest = (id, method, params) => this.answer(id, method, params);
    try {
      await server.call('initialize', {
        clientInfo: { name: 'online-office', title: 'Online Office', version: 'beta' },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: QUIET },
      }, anything, 15_000);
      server.notify('initialized');
      // Codex gets the owner's access token in memory and nothing on disk: no auth.json in the office's home, and no refresh
      // token anywhere near it. When the token stops working it asks for another, in `refreshTokens`.
      await server.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.accessToken, chatgptAccountId: auth.accountId, chatgptPlanType: null }, anything, 15_000);
    } catch (e) {
      server.close();
      throw e;
    }
    this.handedOut = auth.accessToken;
    if (!this.users.size) {
      server.close();
      throw new ServerGone('Codex was not needed any more');
    }
    this.server = server;
    debug('app-server started');
    return server;
  }

  private exited(server: CodexServer, reason: string) {
    if (this.server === server) this.server = undefined;
    if (server.closing) return;
    this.exits.push(Date.now());
    this.lastExit = reason;
    debug(reason);
    for (const user of [...this.users]) user.serverLost(reason);
  }

  private answer(id: RequestId, method: string, params: unknown): Promise<unknown> {
    if (method === 'account/chatgptAuthTokens/refresh') return Promise.resolve(this.refreshTokens());
    const request = parseRequest(method, params);
    if (!request) return Promise.reject(new RpcError(-32601, `The office does not answer ${method}`));
    const user = this.routes.get(request.threadId);
    if (!user) return Promise.reject(new RpcError(-32602, `No employee is working on thread ${request.threadId}`));
    return user.onRequest(id, request);
  }

  // Codex says the access token it holds was refused. Only the owner's own Codex renews it, so the answer is whatever it has
  // written to auth.json since. If that is the token that was refused, there is nothing to hand over.
  private refreshTokens() {
    try {
      const auth = this.readAuth();
      if (auth.accessToken === this.handedOut) {
        throw new CodexSetupError('ChatGPT no longer accepts the sign-in that Codex holds. Open Codex once so it renews, then ask me again.');
      }
      this.handedOut = auth.accessToken;
      return { accessToken: auth.accessToken, chatgptAccountId: auth.accountId, chatgptPlanType: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const user of this.users) user.notice(message);
      throw new RpcError(-32000, message);
    }
  }
}

// ---- the real process

export type CodexPaths = { home: string; emptyHome: string };
export const codexPaths = (root: string): CodexPaths => ({ home: join(root, 'home'), emptyHome: join(root, 'empty-home') });

// How the office starts the app-server, so that nothing of the owner's setup loads into an employee:
// - CODEX_HOME is the office's own folder, so his config.toml, MCP servers, skills, AGENTS.md and memories are not in it.
// - The account features (connectors, plugins, the remote plugin catalog) load whatever the account has, whatever the home.
//   Memories are Codex's own and would read and write his.
// - HOME is an empty folder, which hides ~/.agents/skills. Commands still get the real one, or git and npm would not find
//   their config.
export function codexCommand(paths: CodexPaths, realHome: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    command: 'codex',
    args: [
      'app-server',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'remote_plugin',
      '-c', 'features.memories=false',
      '-c', `shell_environment_policy.set={HOME=${JSON.stringify(realHome)}}`,
    ],
    env: { ...env, CODEX_HOME: paths.home, HOME: paths.emptyHome },
  };
}

export function spawnCodex(paths: CodexPaths, realHome: string): Child {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.emptyHome, { recursive: true });
  const { command, args, env } = codexCommand(paths, realHome);
  return spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
}
