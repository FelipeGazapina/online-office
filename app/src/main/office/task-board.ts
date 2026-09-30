import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TaskBoardSource, TaskCard, TaskConnectionState, TaskProvider } from '../../shared/protocol.ts';

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function fromMcpResult(result: unknown): unknown {
  const record = asRecord(result);
  const content = record?.content;
  if (!Array.isArray(content)) return result;
  const raw = content.find((item) => text(asRecord(item)?.type) === 'text');
  const value = text(asRecord(raw)?.text);
  if (!value) return result;
  try { return JSON.parse(value); } catch { return value; }
}

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(records);
  const record = asRecord(value);
  if (!record) return [];
  const direct = Object.entries(record).flatMap(([key, child]) => key === 'tasks' || key === 'issues' || key === 'nodes' ? records(child) : []);
  if (direct.length) return direct;
  if (text(record.title) || text(record.name)) return [record];
  return Object.values(record).flatMap(records);
}

function nestedName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return text(record.name) || text(record.title) || undefined;
}

export function normalizeTaskPayload(provider: TaskProvider, payload: unknown, source: TaskBoardSource): TaskCard[] {
  const body = fromMcpResult(payload);
  return records(body).flatMap((item) => {
    const title = text(item.title) || text(item.name);
    const rawId = text(item.id) || text(item._id) || text(item.identifier) || text(item.code);
    if (!title || !rawId) return [];
    const identifier = text(item.identifier) || text(item.code) || rawId;
    const state = nestedName(item.state) || text(item.status) || 'Open';
    const priority = nestedName(item.priority) || (typeof item.priority === 'number' ? `P${item.priority}` : undefined);
    const url = text(item.url) || text(item.webUrl) || text(item.link) || undefined;
    return [{
      id: `${provider}:${rawId}`,
      provider,
      identifier,
      title,
      status: state,
      ...(priority ? { priority } : {}),
      ...(url ? { url } : {}),
      sourceLabel: source.label?.trim() || (provider === 'cronospark' ? 'CronoSpark' : 'Linear'),
    }];
  });
}

type Tool = { name: string; description?: string; inputSchema?: JsonRecord };

const toolArguments = (tool: Tool, source: TaskBoardSource): JsonRecord => {
  const properties = asRecord(tool.inputSchema)?.properties;
  const result: JsonRecord = {};
  if (!properties || !Object.keys(properties).length) return { projectId: source.projectId };
  for (const key of Object.keys(properties)) {
    if (/project.?id|project/i.test(key)) result[key] = source.projectId;
  }
  return Object.keys(result).length ? result : { query: source.projectId };
};

export class TaskBoardService {
  private readonly connections = new Map<TaskProvider, TaskConnectionState>();
  private linearProvider?: LinearOAuthProvider;
  private linearCallback?: Server;
  private linearCallbackUrl?: string;
  private readonly openUrl: (url: string) => Promise<void> | void;
  private changed: () => void = () => undefined;

  constructor(options: { openUrl?: (url: string) => Promise<void> | void } = {}) {
    this.openUrl = options.openUrl ?? (() => undefined);
    this.connections.set('cronospark', this.cronoConfig() ? { kind: 'ready' } : { kind: 'needs_auth', message: 'Set CRONOSPARK_MCP_API_KEY to connect CronoSpark.' });
    this.connections.set('linear', process.env.LINEAR_MCP_TOKEN ? { kind: 'ready' } : { kind: 'needs_auth', message: 'Connect Linear through its MCP OAuth flow or set LINEAR_MCP_TOKEN.' });
  }

  setOnChange(changed: () => void) { this.changed = changed; }

  async close() {
    await new Promise<void>((resolve) => {
      if (!this.linearCallback) return resolve();
      this.linearCallback.close(() => resolve());
      this.linearCallback = undefined;
    });
  }

  connectionStates(): Record<TaskProvider, TaskConnectionState> {
    return { linear: this.connections.get('linear')!, cronospark: this.connections.get('cronospark')! };
  }

  connect(provider: TaskProvider): TaskConnectionState {
    const state = this.connections.get(provider)!;
    if (state.kind === 'ready') return state;
    if (provider === 'cronospark') {
      const next = { kind: 'needs_auth' as const, message: 'Set CRONOSPARK_MCP_API_KEY and CRONOSPARK_MCP_USER_ID in the app environment.' };
      this.connections.set(provider, next);
      return next;
    }
    this.connections.set('linear', { kind: 'connecting', message: 'Opening Linear authorization in your browser…' });
    void this.authorizeLinear();
    return this.connections.get('linear')!;
  }

  private async authorizeLinear() {
    try {
      const provider = await this.linearAuthProvider();
      const result = await auth(provider, { serverUrl: 'https://mcp.linear.app/mcp', scope: 'read' });
      if (result === 'AUTHORIZED') { this.connections.set('linear', { kind: 'ready' }); this.changed(); }
    } catch (error) {
      this.connections.set('linear', { kind: 'error', message: error instanceof Error ? error.message : String(error) }); this.changed();
    }
  }

  private async linearAuthProvider() {
    if (this.linearProvider) return this.linearProvider;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/linear') { response.writeHead(404); response.end(); return; }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400); response.end('Missing OAuth code'); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Online Office</title><p>Linear is connected. You can close this tab.</p>');
      void this.finishLinearAuth(code);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start the Linear OAuth callback');
    this.linearCallback = server;
    this.linearCallbackUrl = `http://127.0.0.1:${address.port}/oauth/linear`;
    this.linearProvider = new LinearOAuthProvider(this.linearCallbackUrl, async (url) => this.openUrl(url));
    return this.linearProvider;
  }

  private async finishLinearAuth(code: string) {
    const provider = this.linearProvider;
    if (!provider) return;
    try {
      const result = await auth(provider, { serverUrl: 'https://mcp.linear.app/mcp', authorizationCode: code, scope: 'read' });
      if (result === 'AUTHORIZED') this.connections.set('linear', { kind: 'ready' });
      else this.connections.set('linear', { kind: 'error', message: 'Linear did not finish authorization.' });
      this.changed();
    } catch (error) {
      this.connections.set('linear', { kind: 'error', message: error instanceof Error ? error.message : String(error) }); this.changed();
    }
  }

  async fetchSources(sources: readonly TaskBoardSource[]): Promise<{ cards: TaskCard[]; errors: string[] }> {
    const results = await Promise.all(sources.map(async (source) => {
      try { return await this.fetchSource(source); } catch (error) { return { cards: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    return { cards: results.flatMap((result) => result.cards), errors: results.flatMap((result) => result.error ? [result.error] : []) };
  }

  private cronoConfig() {
    const token = process.env.CRONOSPARK_MCP_API_KEY || process.env.CRONOSPARK_MCP_TOKEN;
    if (!token) return undefined;
    return { url: process.env.CRONOSPARK_MCP_URL || 'https://mcp.cronospark.lypes.agency/mcp', headers: { Authorization: `Bearer ${token}`, ...(process.env.CRONOSPARK_MCP_USER_ID ? { 'X-MCP-User-ID': process.env.CRONOSPARK_MCP_USER_ID } : {}) } };
  }

  private async fetchSource(source: TaskBoardSource): Promise<{ cards: TaskCard[]; error?: string }> {
    const fixture = process.env.OFFICE_TASK_BOARD_FIXTURE;
    if (fixture && source.provider === 'cronospark') {
      return { cards: normalizeTaskPayload(source.provider, JSON.parse(readFileSync(fixture, 'utf8')), source) };
    }
    const config = source.provider === 'cronospark' ? this.cronoConfig() : process.env.LINEAR_MCP_TOKEN ? { url: 'https://mcp.linear.app/mcp', headers: { Authorization: `Bearer ${process.env.LINEAR_MCP_TOKEN}` } } : this.connections.get('linear')?.kind === 'ready' ? { url: 'https://mcp.linear.app/mcp', headers: {} } : undefined;
    if (!config) return { cards: [], error: this.connections.get(source.provider)?.message || `${source.provider} is not connected.` };
    const client = new Client({ name: 'online-office-task-board', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, ...(source.provider === 'linear' && this.linearProvider ? { authProvider: this.linearProvider } : {}) });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools as Tool[];
      const tool = source.provider === 'cronospark'
        ? tools.find((candidate) => candidate.name === 'listar_tasks_projeto')
        : tools.find((candidate) => /issue|task/i.test(`${candidate.name} ${candidate.description ?? ''}`) && /list|search|find/i.test(`${candidate.name} ${candidate.description ?? ''}`));
      if (!tool) return { cards: [], error: `No task-listing tool is available from ${source.provider}.` };
      const result = await client.callTool({ name: tool.name, arguments: toolArguments(tool, source) });
      return { cards: normalizeTaskPayload(source.provider, result, source) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

class LinearOAuthProvider implements OAuthClientProvider {
  private client?: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
  private currentTokens?: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
  private verifier?: string;
  private readonly callbackUrl: string;
  private readonly open: (url: string) => Promise<void> | void;
  constructor(callbackUrl: string, open: (url: string) => Promise<void> | void) { this.callbackUrl = callbackUrl; this.open = open; }
  get redirectUrl() { return this.callbackUrl; }
  get clientMetadata() { return { client_name: 'Online Office', redirect_uris: [this.callbackUrl], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'read' }; }
  clientInformation() { return this.client; }
  saveClientInformation(client: NonNullable<Awaited<ReturnType<OAuthClientProvider['clientInformation']>>>) { this.client = client; }
  tokens() { return this.currentTokens; }
  saveTokens(tokens: NonNullable<Awaited<ReturnType<OAuthClientProvider['tokens']>>>) { this.currentTokens = tokens; }
  redirectToAuthorization(url: URL) { return this.open(url.toString()); }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error('Linear OAuth verifier is missing'); return this.verifier; }
}
