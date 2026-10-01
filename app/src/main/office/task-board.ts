import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TaskBoardSource, TaskCard, TaskConnectionState, TaskProvider } from '../../shared/protocol.ts';

type JsonRecord = Record<string, unknown>;
type CredentialsCodec = { encode(value: string): string; decode(value: string): string };
type LinearCredentials = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; callbackUrl?: string };
type StoredCredentials = { cronospark?: { encrypted?: unknown; apiKey?: unknown; userId?: unknown; url?: unknown }; linear?: { encrypted?: unknown; client?: unknown; tokens?: unknown; callbackUrl?: unknown } };

const asRecord = (value: unknown): JsonRecord | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const normalizeToken = (value: string) => value.trim().replace(/^Bearer\s+/i, '');

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
    const description = text(item.description) || text(item.body) || text(item.details) || undefined;
    const url = text(item.url) || text(item.webUrl) || text(item.link) || undefined;
    return [{
      id: `${provider}:${rawId}`,
      provider,
      identifier,
      title,
      status: state,
      ...(priority ? { priority } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      sourceLabel: source.label?.trim() || (provider === 'cronospark' ? 'CronoSpark' : 'Linear'),
    }];
  });
}

type Tool = { name: string; description?: string; inputSchema?: JsonRecord };

type LinearSelector =
  | { kind: 'team'; team: string; workspace?: string; raw: string }
  | { kind: 'project'; project: string; workspace?: string; raw: string }
  | { kind: 'workspace'; workspace: string; raw: string }
  | { kind: 'auto'; value: string; raw: string };

const fieldName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const LINEAR_HOST = /(^|\.)linear\.app$/i;

function linearUrl(value: string): LinearSelector | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!LINEAR_HOST.test(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const marker = parts.findIndex((part) => /^(team|project)$/i.test(part));
  if (parts.length === 1) return { kind: 'workspace', workspace: parts[0]!, raw: value.trim() };
  if (marker < 1 || !parts[marker + 1]) return undefined;
  const workspace = parts[0];
  const raw = value.trim();
  if (parts[marker]!.toLowerCase() === 'team') return { kind: 'team', team: parts[marker + 1]!, workspace, raw };
  return { kind: 'project', project: parts[marker + 1]!, workspace, raw };
}

export function parseLinearSelector(value: string): LinearSelector {
  const raw = value.trim();
  const urlSelector = linearUrl(raw);
  if (urlSelector) return urlSelector;
  if (/^https?:\/\//i.test(raw)) throw new Error('Use a Linear workspace, team, or project URL.');
  const prefixed = raw.match(/^(team|project|workspace)\s*:\s*(.+)$/i);
  if (prefixed) {
    const identifier = prefixed[2]!.trim();
    if (prefixed[1]!.toLowerCase() === 'team') return { kind: 'team', team: identifier, raw };
    if (prefixed[1]!.toLowerCase() === 'project') return { kind: 'project', project: identifier, raw };
    return { kind: 'workspace', workspace: identifier, raw };
  }
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(raw)) return { kind: 'workspace', workspace: raw, raw };
  return { kind: 'auto', value: raw, raw };
}

type LinearToolArguments = { args: JsonRecord; selector: LinearSelector; unfilteredWorkspace?: boolean };

const selectorField = (key: string, selector: LinearSelector): string | undefined => {
  const name = fieldName(key);
  if (selector.kind === 'team' && ['team', 'teamid', 'teamkey', 'teamidentifier'].includes(name)) return selector.team;
  if (selector.kind === 'project' && ['project', 'projectid', 'projectidentifier', 'projectkey'].includes(name)) return selector.project;
  if (selector.kind !== 'workspace' && selector.kind !== 'auto' && selector.workspace && ['workspace', 'workspaceid', 'workspaceslug', 'organization', 'organizationid', 'organizationslug', 'org', 'orgid'].includes(name)) return selector.workspace;
  if (selector.kind === 'workspace' && ['workspace', 'workspaceid', 'workspaceslug', 'organization', 'organizationid', 'organizationslug', 'org', 'orgid'].includes(name)) return selector.workspace;
  if (selector.kind === 'auto') {
    if (/^[A-Z][A-Z0-9_]*$/.test(selector.value) && ['team', 'teamid', 'teamkey', 'teamidentifier'].includes(name)) return selector.value;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(selector.value) && ['project', 'projectid', 'projectidentifier', 'projectkey'].includes(name)) return selector.value;
    if (['workspace', 'workspaceid', 'workspaceslug', 'organization', 'organizationid', 'organizationslug', 'org', 'orgid'].includes(name)) return selector.value;
  }
  return undefined;
};

function linearFields(properties: JsonRecord, selector: LinearSelector): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, schema] of Object.entries(properties)) {
    const value = selectorField(key, selector);
    if (value !== undefined) { result[key] = value; continue; }
    const nested = asRecord(schema);
    const nestedProperties = asRecord(nested?.properties);
    if (nestedProperties) {
      const child = linearFields(nestedProperties, selector);
      if (Object.keys(child).length) result[key] = child;
    }
  }
  return result;
}

export function linearToolArguments(tool: Tool, source: TaskBoardSource): LinearToolArguments {
  const selector = parseLinearSelector(source.projectId);
  const properties = asRecord(asRecord(tool.inputSchema)?.properties);
  const args: JsonRecord = properties ? linearFields(properties, selector) : {};
  if (selector.kind === 'auto' && !Object.keys(args).length && properties) {
    const projectKey = Object.keys(properties).find((key) => ['project', 'projectid', 'projectidentifier', 'projectkey'].includes(fieldName(key)));
    if (projectKey) args[projectKey] = selector.value;
  }
  if (selector.kind !== 'workspace' && !Object.keys(args).length) throw new Error('The Linear issue tool cannot filter this source. Use team:BLOOM or project:<project id>.');
  return { args, selector, ...(selector.kind === 'workspace' && !Object.keys(args).length ? { unfilteredWorkspace: true } : {}) };
}

const toolArguments = (tool: Tool, source: TaskBoardSource): JsonRecord => {
  const properties = asRecord(asRecord(tool.inputSchema)?.properties);
  const result: JsonRecord = {};
  if (!properties || !Object.keys(properties).length) return { projectId: source.projectId };
  for (const key of Object.keys(properties)) {
    if (/project.?id|project/i.test(key)) result[key] = source.projectId;
  }
  return Object.keys(result).length ? result : { query: source.projectId };
};

export class TaskBoardService {
  private readonly connections = new Map<TaskProvider, TaskConnectionState>();
  private readonly credentialsFile?: string;
  private readonly credentialsCodec?: CredentialsCodec;
  private cronosparkCredentials?: { apiKey: string; userId: string; url?: string };
  private linearProvider?: LinearOAuthProvider;
  private linearProviderPromise?: Promise<LinearOAuthProvider>;
  private linearCallback?: Server;
  private linearCallbackUrl?: string;
  private linearCredentials?: LinearCredentials;
  private readonly openUrl: (url: string) => Promise<void> | void;
  private changed: () => void = () => undefined;

  constructor(options: { openUrl?: (url: string) => Promise<void> | void; credentialsFile?: string; credentialsCodec?: CredentialsCodec } = {}) {
    this.openUrl = options.openUrl ?? (() => undefined);
    this.credentialsFile = options.credentialsFile;
    this.credentialsCodec = options.credentialsCodec;
    this.cronosparkCredentials = this.loadCronoSparkCredentials();
    this.linearCredentials = this.loadLinearCredentials();
    const crono = this.cronoConfig();
    this.connections.set('cronospark', crono ? { kind: 'ready', userId: this.cronosparkCredentials?.userId, hasApiKey: !!this.cronosparkCredentials?.apiKey } : { kind: 'needs_auth', message: 'Enter the CronoSpark API key and user ID below.', userId: this.cronosparkCredentials?.userId, hasApiKey: !!this.cronosparkCredentials?.apiKey });
    this.connections.set('linear', process.env.LINEAR_MCP_TOKEN || this.linearCredentials?.tokens ? { kind: 'ready' } : { kind: 'needs_auth', message: 'Connect Linear through its MCP OAuth flow or set LINEAR_MCP_TOKEN.' });
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
    if (state.kind === 'connecting') return state;
    if (provider === 'cronospark') {
      const next = { kind: 'needs_auth' as const, message: 'Enter the CronoSpark API key and user ID below.', userId: this.cronosparkCredentials?.userId, hasApiKey: !!this.cronosparkCredentials?.apiKey };
      this.connections.set(provider, next);
      return next;
    }
    this.connections.set('linear', { kind: 'connecting', message: 'Opening Linear authorization in your browser…' });
    this.changed();
    void this.authorizeLinear();
    return this.connections.get('linear')!;
  }

  configureCronoSpark(apiKey: string, userId: string) {
    const current = this.cronosparkCredentials ?? this.environmentCronoSparkCredentials();
    const token = normalizeToken(apiKey) || current?.apiKey || '';
    const account = userId.trim() || current?.userId || '';
    if (!token || !account) throw new Error('CronoSpark needs both an API key and an MCP user ID.');
    this.cronosparkCredentials = { apiKey: token, userId: account, ...(current?.url ? { url: current.url } : {}) };
    this.saveCronoSparkCredentials(this.cronosparkCredentials);
    this.connections.set('cronospark', { kind: 'ready', userId: account, hasApiKey: true, message: 'Credentials saved on this Mac.' });
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
    if (this.linearProviderPromise) return this.linearProviderPromise;
    this.linearProviderPromise = this.startLinearAuthProvider();
    try { return await this.linearProviderPromise; } finally { this.linearProviderPromise = undefined; }
  }

  private async startLinearAuthProvider() {
    const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/linear') { response.writeHead(404); response.end(); return; }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400); response.end('Missing OAuth code'); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Online Office</title><p>Linear is connected. You can close this tab.</p>');
      void this.finishLinearAuth(code);
    };
    const preferredPort = this.linearCredentials?.callbackUrl ? Number(new URL(this.linearCredentials.callbackUrl).port) : 0;
    let server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(preferredPort || 0, '127.0.0.1', resolve); });
    } catch (error) {
      if (!preferredPort) throw error;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = createServer(handler);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start the Linear OAuth callback');
    this.linearCallback = server;
    this.linearCallbackUrl = `http://127.0.0.1:${address.port}/oauth/linear`;
    const callbackChanged = this.linearCredentials?.callbackUrl !== this.linearCallbackUrl;
    const client = callbackChanged ? undefined : this.linearCredentials?.client;
    if (callbackChanged && this.linearCredentials?.client) this.linearCredentials = { ...this.linearCredentials, client: undefined };
    this.linearProvider = new LinearOAuthProvider(this.linearCallbackUrl, async (url) => this.openUrl(url), client, this.linearCredentials?.tokens, (next) => this.saveLinearCredentials(next));
    return this.linearProvider;
  }

  private async finishLinearAuth(code: string) {
    const provider = this.linearProvider;
    if (!provider) return;
    try {
      const result = await auth(provider, { serverUrl: 'https://mcp.linear.app/mcp', authorizationCode: code, scope: 'read' });
      if (result === 'AUTHORIZED') this.connections.set('linear', { kind: 'ready', message: 'Connected to the signed-in Linear account.' });
      else this.connections.set('linear', { kind: 'error', message: 'Linear did not finish authorization.' });
      this.changed();
      if (this.linearCallback) {
        this.linearCallback.close();
        this.linearCallback = undefined;
      }
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
    const credentials = this.cronosparkCredentials ?? this.environmentCronoSparkCredentials();
    if (!credentials?.apiKey || !credentials.userId) return undefined;
    return { url: credentials.url || process.env.CRONOSPARK_MCP_URL || 'https://mcp.cronospark.lypes.agency/mcp', headers: { Authorization: `Bearer ${credentials.apiKey}`, 'X-MCP-User-ID': credentials.userId } };
  }

  private environmentCronoSparkCredentials() {
    const apiKey = normalizeToken(process.env.CRONOSPARK_MCP_API_KEY || process.env.CRONOSPARK_MCP_TOKEN || '');
    const userId = (process.env.CRONOSPARK_MCP_USER_ID || '').trim();
    return apiKey || userId ? { apiKey, userId, ...(process.env.CRONOSPARK_MCP_URL ? { url: process.env.CRONOSPARK_MCP_URL } : {}) } : undefined;
  }

  private loadCronoSparkCredentials() {
    const fromEnvironment = this.environmentCronoSparkCredentials();
    if (!this.credentialsFile) return fromEnvironment;
    try {
      const stored = JSON.parse(readFileSync(this.credentialsFile, 'utf8')) as StoredCredentials;
      let saved: { apiKey?: unknown; userId?: unknown; url?: unknown } = stored.cronospark ?? {};
      if (this.credentialsCodec && typeof stored.cronospark?.encrypted === 'string') saved = JSON.parse(this.credentialsCodec.decode(stored.cronospark.encrypted)) as typeof saved;
      const apiKey = normalizeToken(typeof saved.apiKey === 'string' ? saved.apiKey : '') || fromEnvironment?.apiKey || '';
      const userId = (typeof saved.userId === 'string' ? saved.userId : '').trim() || fromEnvironment?.userId || '';
      const url = (typeof saved.url === 'string' ? saved.url.trim() : '') || fromEnvironment?.url;
      return apiKey || userId ? { apiKey, userId, ...(url ? { url } : {}) } : undefined;
    } catch {
      return fromEnvironment;
    }
  }

  private saveCronoSparkCredentials(credentials: { apiKey: string; userId: string; url?: string }) {
    if (!this.credentialsFile) return;
    mkdirSync(dirname(this.credentialsFile), { recursive: true, mode: 0o700 });
    const temp = `${this.credentialsFile}.${process.pid}.tmp`;
    const saved = this.credentialsCodec ? { encrypted: this.credentialsCodec.encode(JSON.stringify(credentials)) } : credentials;
    let existing: StoredCredentials = {};
    try { existing = JSON.parse(readFileSync(this.credentialsFile, 'utf8')) as StoredCredentials; } catch {}
    writeFileSync(temp, JSON.stringify({ ...existing, cronospark: saved }, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.credentialsFile);
    chmodSync(this.credentialsFile, 0o600);
  }

  private loadLinearCredentials(): LinearCredentials | undefined {
    if (!this.credentialsFile) return undefined;
    try {
      const stored = JSON.parse(readFileSync(this.credentialsFile, 'utf8')) as StoredCredentials;
      let saved: { client?: unknown; tokens?: unknown; callbackUrl?: unknown } = stored.linear ?? {};
      if (this.credentialsCodec && typeof stored.linear?.encrypted === 'string') saved = JSON.parse(this.credentialsCodec.decode(stored.linear.encrypted)) as typeof saved;
      const tokens = OAuthTokensSchema.safeParse(saved.tokens);
      if (!tokens.success) return undefined;
      const fullClient = OAuthClientInformationFullSchema.safeParse(saved.client);
      const basicClient = fullClient.success ? undefined : OAuthClientInformationSchema.safeParse(saved.client);
      const client = fullClient.success ? fullClient.data : basicClient?.success ? basicClient.data : undefined;
      const callbackCandidate = typeof saved.callbackUrl === 'string' ? saved.callbackUrl.trim() : '';
      const registeredCallback = fullClient.success && fullClient.data.redirect_uris[0] ? fullClient.data.redirect_uris[0].toString() : '';
      const callbackUrl = [callbackCandidate, registeredCallback].find((value) => /^http:\/\/127\.0\.0\.1:\d+\/oauth\/linear$/.test(value));
      return { tokens: tokens.data, ...(client ? { client } : {}), ...(callbackUrl ? { callbackUrl } : {}) };
    } catch {
      return undefined;
    }
  }

  private saveLinearCredentials(credentials: LinearCredentials) {
    this.linearCredentials = credentials;
    if (!this.credentialsFile || !credentials.tokens) return;
    mkdirSync(dirname(this.credentialsFile), { recursive: true, mode: 0o700 });
    const temp = `${this.credentialsFile}.${process.pid}.tmp`;
    const payload = { client: credentials.client, tokens: credentials.tokens, callbackUrl: credentials.callbackUrl };
    const saved = this.credentialsCodec ? { encrypted: this.credentialsCodec.encode(JSON.stringify(payload)) } : payload;
    let existing: StoredCredentials = {};
    try { existing = JSON.parse(readFileSync(this.credentialsFile, 'utf8')) as StoredCredentials; } catch {}
    writeFileSync(temp, JSON.stringify({ ...existing, linear: saved }, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.credentialsFile);
    chmodSync(this.credentialsFile, 0o600);
  }

  private async fetchSource(source: TaskBoardSource): Promise<{ cards: TaskCard[]; error?: string }> {
    const fixture = process.env.OFFICE_TASK_BOARD_FIXTURE;
    if (fixture && source.provider === 'cronospark') {
      return { cards: normalizeTaskPayload(source.provider, JSON.parse(readFileSync(fixture, 'utf8')), source) };
    }
    const linearProvider = source.provider === 'linear' && !process.env.LINEAR_MCP_TOKEN && this.connections.get('linear')?.kind === 'ready' ? await this.linearAuthProvider() : undefined;
    const config = source.provider === 'cronospark' ? this.cronoConfig() : process.env.LINEAR_MCP_TOKEN ? { url: 'https://mcp.linear.app/mcp', headers: { Authorization: `Bearer ${process.env.LINEAR_MCP_TOKEN}` } } : linearProvider ? { url: 'https://mcp.linear.app/mcp', headers: {} } : undefined;
    if (!config) return { cards: [], error: this.connections.get(source.provider)?.message || `${source.provider} is not connected.` };
    const client = new Client({ name: 'online-office-task-board', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, ...(linearProvider ? { authProvider: linearProvider } : {}) });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools as Tool[];
      const tool = source.provider === 'cronospark'
        ? tools.find((candidate) => candidate.name === 'listar_tasks_projeto')
        : tools.find((candidate) => candidate.name === 'list_issues')
          ?? tools.find((candidate) => /issue|task/i.test(`${candidate.name} ${candidate.description ?? ''}`) && /list|search|find/i.test(`${candidate.name} ${candidate.description ?? ''}`));
      if (!tool) return { cards: [], error: `No task-listing tool is available from ${source.provider}.` };
      const argumentsForTool = source.provider === 'linear' ? linearToolArguments(tool, source).args : toolArguments(tool, source);
      const result = await client.callTool({ name: tool.name, arguments: argumentsForTool });
      return { cards: normalizeTaskPayload(source.provider, result, source) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

class LinearOAuthProvider implements OAuthClientProvider {
  private client?: OAuthClientInformationMixed;
  private currentTokens?: OAuthTokens;
  private verifier?: string;
  private readonly callbackUrl: string;
  private readonly open: (url: string) => Promise<void> | void;
  private readonly persist?: (credentials: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; callbackUrl?: string }) => void;
  constructor(callbackUrl: string, open: (url: string) => Promise<void> | void, client?: OAuthClientInformationMixed, tokens?: OAuthTokens, persist?: (credentials: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; callbackUrl?: string }) => void) {
    this.callbackUrl = callbackUrl;
    this.open = open;
    this.client = client;
    this.currentTokens = tokens;
    this.persist = persist;
  }
  get redirectUrl() { return this.callbackUrl; }
  get clientMetadata() { return { client_name: 'Online Office', redirect_uris: [this.callbackUrl], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'read' }; }
  clientInformation() { return this.client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.client = client; this.persist?.({ client, tokens: this.currentTokens, callbackUrl: this.callbackUrl }); }
  tokens() { return this.currentTokens; }
  saveTokens(tokens: OAuthTokens) { this.currentTokens = tokens; this.persist?.({ client: this.client, tokens, callbackUrl: this.callbackUrl }); }
  redirectToAuthorization(url: URL) { return this.open(url.toString()); }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error('Linear OAuth verifier is missing'); return this.verifier; }
}
