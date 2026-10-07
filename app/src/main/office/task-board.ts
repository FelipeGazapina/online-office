import { createServer, type Server } from 'node:http';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { filtersOf, type LinearPerson, type TaskBoardSource, type TaskCard, type TaskConnectionState, type TaskProvider } from '../../shared/protocol.ts';

type JsonRecord = Record<string, unknown>;
// The arguments of CronoSpark's registrar_horas.
export type HoursCall = { taskId: string; hours: number; date: string; description: string };
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
    const url = text(item.url) || text(item.webUrl) || text(item.link) || undefined;
    return [{
      id: `${provider}:${rawId}`,
      provider,
      externalId: rawId,
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

const properties = (tool: Tool): JsonRecord => asRecord(asRecord(tool.inputSchema)?.properties) ?? {};
const keyOf = (props: JsonRecord, names: readonly string[]) => Object.keys(props).find((key) => names.includes(fieldName(key)));
const TEAM_FIELDS = ['team', 'teamid', 'teamkey', 'teamidentifier'];

// How a tool pages, read from its input schema. Linear's list_issues takes a `limit` (up to 250) and a cursor.
export type LinearPaging = { limitKey?: string; pageMax?: number; cursorKey?: string };

export function linearPaging(tool: Tool): LinearPaging {
  const props = properties(tool);
  const limitKey = keyOf(props, ['limit']);
  const cursorKey = keyOf(props, ['cursor', 'after']);
  const max = limitKey ? asRecord(props[limitKey])?.maximum : undefined;
  return { ...(limitKey ? { limitKey } : {}), ...(typeof max === 'number' && max > 0 ? { pageMax: max } : {}), ...(cursorKey ? { cursorKey } : {}) };
}

// The arguments of one list_issues call: the source's team or project, then who and which cycle. `cycle` is what the tool is
// told for the current cycle: the id cyclesCall found, or the word itself. A filter the tool has no field for fails the
// sync, because dropping it would show issues the owner filtered out.
export function linearToolArguments(tool: Tool, source: TaskBoardSource, cycle = 'current'): LinearToolArguments {
  const selector = parseLinearSelector(source.projectId);
  const props = properties(tool);
  const args: JsonRecord = Object.keys(props).length ? linearFields(props, selector) : {};
  if (selector.kind === 'auto' && !Object.keys(args).length && Object.keys(props).length) {
    const projectKey = Object.keys(props).find((key) => ['project', 'projectid', 'projectidentifier', 'projectkey'].includes(fieldName(key)));
    if (projectKey) args[projectKey] = selector.value;
  }
  if (selector.kind !== 'workspace' && !Object.keys(args).length) throw new Error('The Linear issue tool cannot filter this source. Use team:BLOOM or project:<project id>.');
  const unfilteredWorkspace = selector.kind === 'workspace' && !Object.keys(args).length;
  const f = filtersOf(source);
  if (f.assignee !== 'anyone') {
    const key = keyOf(props, ['assignee', 'assigneeid']);
    if (!key) throw new Error('The Linear issue tool cannot filter by assignee, so this source would show everyone\'s issues. Set the assignee back to Anyone.');
    args[key] = f.assignee === 'me' ? 'me' : f.assignee.id;
  }
  if (f.cycle === 'current') {
    const key = keyOf(props, ['cycle', 'cycleid']);
    if (!key) throw new Error('The Linear issue tool cannot filter by cycle, so this source would show every cycle. Set the cycle back to Any.');
    args[key] = cycle;
  }
  return { args, selector, ...(unfilteredWorkspace ? { unfilteredWorkspace } : {}) };
}

// The cycle a team is in now, in the words list_issues takes (the id), or undefined when the tools cannot say: no
// list_cycles tool, one that takes no team or no type, or a source that is not a team.
export function cyclesCall(tool: Tool | undefined, selector: LinearSelector): JsonRecord | undefined {
  if (!tool || selector.kind !== 'team') return undefined;
  const props = properties(tool);
  const team = keyOf(props, TEAM_FIELDS);
  const type = keyOf(props, ['type']);
  return team && type ? { [team]: selector.team, [type]: 'current' } : undefined;
}

export function currentCycleId(body: unknown): string {
  const list = Array.isArray(body) ? body : asRecord(body)?.cycles;
  const first = asRecord(Array.isArray(list) ? list[0] : undefined);
  const id = text(first?.id) || (typeof first?.number === 'number' ? String(first.number) : text(first?.number));
  if (!id) throw new Error('This Linear team has no current cycle.');
  return id;
}

// Where the next page starts, or undefined at the end. The cursor comes back in the page; a tool that pages with `after`
// and returns no cursor is continued from its last issue.
function nextCursor(body: unknown, lastId: string | undefined, cursorKey: string): string | undefined {
  const page = asRecord(body);
  const info = asRecord(page?.pageInfo);
  const more = page?.hasNextPage ?? info?.hasNextPage ?? page?.hasMore;
  if (more === false) return undefined;
  const given = [page?.nextCursor, page?.cursor, page?.endCursor, info?.endCursor].map(text).find(Boolean);
  return given || (more === true && fieldName(cursorKey) === 'after' ? lastId : undefined);
}

const MAX_PAGES = 20;
// The assignee picker lists this many of Linear's users at most.
const PEOPLE_CAP = 500;

// Reads pages until `want` items passed `keep` or the tool has no more. What `keep` drops costs nothing against `want`, so
// a column the owner folded away does not eat the limit. Stops after MAX_PAGES pages, which bounds a workspace whose
// open issues are few among very many closed ones.
export async function collectPages<T extends { id: string }>(a: {
  tool: Tool;
  base: JsonRecord;
  want: number;
  call: (args: JsonRecord) => Promise<unknown>;
  read: (result: unknown) => T[];
  lastId: (item: T) => string;
  keep?: (item: T) => boolean;
}): Promise<T[]> {
  const { limitKey, pageMax, cursorKey } = linearPaging(a.tool);
  const size = Math.min(a.want, pageMax ?? a.want);
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && out.length < a.want; page++) {
    const result = await a.call({ ...a.base, ...(limitKey ? { [limitKey]: size } : {}), ...(cursor && cursorKey ? { [cursorKey]: cursor } : {}) });
    const batch = a.read(result);
    for (const item of batch) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (out.length < a.want && (a.keep?.(item) ?? true)) out.push(item);
    }
    const next = cursorKey && batch.length ? nextCursor(fromMcpResult(result), batch.at(-1) && a.lastId(batch.at(-1)!), cursorKey) : undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

export function normalizePeople(payload: unknown): LinearPerson[] {
  const seen = new Set<string>();
  return records(fromMcpResult(payload)).flatMap((item) => {
    const id = text(item.id);
    const name = text(item.name) || text(item.displayName);
    if (!id || !name || item.active === false || item.disabled === true || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
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

  // `keep` drops the cards a board does not want before they count against a source's limit.
  async fetchSources(sources: readonly TaskBoardSource[], keep: (card: TaskCard) => boolean = () => true): Promise<{ cards: TaskCard[]; errors: string[] }> {
    const results = await Promise.all(sources.map(async (source) => {
      try { return await this.fetchSource(source, keep); } catch (error) { return { cards: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    return { cards: results.flatMap((result) => result.cards), errors: results.flatMap((result) => result.error ? [result.error] : []) };
  }

  // Everyone the assignee picker can offer, from Linear's own user list.
  async linearPeople(): Promise<LinearPerson[]> {
    return this.withClient('linear', async (client, tools) => {
      const tool = tools.find((candidate) => candidate.name === 'list_users')
        ?? tools.find((candidate) => /user/i.test(candidate.name) && /list|search|find/i.test(candidate.name));
      if (!tool) throw new Error('Linear offers no tool that lists its users.');
      const people = await collectPages({
        tool,
        base: {},
        want: PEOPLE_CAP,
        call: (args) => client.callTool({ name: tool.name, arguments: args }),
        read: normalizePeople,
        lastId: (person) => person.id,
      });
      return people.sort((a, b) => a.name.localeCompare(b.name));
    });
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

  // Sends one person's hours on one task for one day. Throws when CronoSpark says no, so the caller can try again later.
  // A fixture run has no server to send to, so the entry goes to the file named by OFFICE_TASK_BOARD_HOURS_LOG, or nowhere.
  async logHours(entry: HoursCall): Promise<void> {
    if (process.env.OFFICE_TASK_BOARD_FIXTURE) {
      if (process.env.OFFICE_TASK_BOARD_HOURS_LOG) appendFileSync(process.env.OFFICE_TASK_BOARD_HOURS_LOG, `${JSON.stringify(entry)}\n`);
      return;
    }
    const config = this.cronoConfig();
    if (!config) throw new Error(this.connections.get('cronospark')?.message || 'CronoSpark is not connected.');
    const client = new Client({ name: 'online-office-task-board', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'registrar_horas', arguments: { ...entry } });
      const body = fromMcpResult(result);
      const failed = asRecord(result)?.isError === true || asRecord(body)?.ok === false;
      if (failed) throw new Error(text(asRecord(body)?.error) || text(asRecord(body)?.message) || (typeof body === 'string' ? body : '') || 'CronoSpark refused the hours.');
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // Connects to the provider's MCP server, runs `use` with its tools, and closes the connection.
  private async withClient<T>(provider: TaskProvider, use: (client: Client, tools: Tool[]) => Promise<T>): Promise<T> {
    const linearProvider = provider === 'linear' && !process.env.LINEAR_MCP_TOKEN && this.connections.get('linear')?.kind === 'ready' ? await this.linearAuthProvider() : undefined;
    const linearUrl = process.env.LINEAR_MCP_URL || 'https://mcp.linear.app/mcp';
    const config = provider === 'cronospark' ? this.cronoConfig() : process.env.LINEAR_MCP_TOKEN ? { url: linearUrl, headers: { Authorization: `Bearer ${process.env.LINEAR_MCP_TOKEN}` } } : linearProvider ? { url: linearUrl, headers: {} } : undefined;
    if (!config) throw new Error(this.connections.get(provider)?.message || `${provider} is not connected.`);
    const client = new Client({ name: 'online-office-task-board', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, ...(linearProvider ? { authProvider: linearProvider } : {}) });
    try {
      await client.connect(transport);
      return await use(client, (await client.listTools()).tools as Tool[]);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async fetchSource(source: TaskBoardSource, keep: (card: TaskCard) => boolean): Promise<{ cards: TaskCard[]; error?: string }> {
    const fixture = process.env.OFFICE_TASK_BOARD_FIXTURE;
    if (fixture && source.provider === 'cronospark') {
      return { cards: normalizeTaskPayload(source.provider, JSON.parse(readFileSync(fixture, 'utf8')), source).filter(keep) };
    }
    return this.withClient(source.provider, async (client, tools) => {
      // A tool that says it failed has not answered with zero issues: reading its message as an empty list would end the sync
      // "ready" and drop every task that was not worked on.
      const call = async (name: string, args: JsonRecord) => {
        const result = await client.callTool({ name, arguments: args });
        if (asRecord(result)?.isError !== true) return result;
        const body = fromMcpResult(result);
        throw new Error(text(asRecord(body)?.message) || (typeof body === 'string' ? body : '') || `${name} failed.`);
      };
      if (source.provider === 'cronospark') {
        const tool = tools.find((candidate) => candidate.name === 'listar_tasks_projeto');
        if (!tool) return { cards: [], error: 'No task-listing tool is available from cronospark.' };
        return { cards: normalizeTaskPayload('cronospark', await call(tool.name, toolArguments(tool, source)), source).filter(keep) };
      }
      const tool = tools.find((candidate) => candidate.name === 'list_issues')
        ?? tools.find((candidate) => /issue|task/i.test(`${candidate.name} ${candidate.description ?? ''}`) && /list|search|find/i.test(`${candidate.name} ${candidate.description ?? ''}`));
      if (!tool) return { cards: [], error: 'No task-listing tool is available from linear.' };
      // The cycle is looked up first because a tool that takes a cycle takes its id, not the word "current".
      let cycle: string | undefined;
      if (filtersOf(source).cycle === 'current') {
        const cycles = tools.find((candidate) => candidate.name === 'list_cycles');
        const asked = cyclesCall(cycles, parseLinearSelector(source.projectId));
        if (cycles && asked) cycle = currentCycleId(fromMcpResult(await call(cycles.name, asked)));
      }
      const { args } = linearToolArguments(tool, source, cycle);
      const cards = await collectPages({
        tool,
        base: args,
        want: filtersOf(source).limit,
        call: (page) => call(tool.name, page),
        read: (result) => normalizeTaskPayload('linear', result, source),
        lastId: (card) => card.externalId,
        keep,
      });
      return { cards };
    });
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
