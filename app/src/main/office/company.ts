import { boardPage } from './board.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { ALLOW_ANSWER, covers, isAllow, ruleFor, sameRule, type PermissionBody } from '../../shared/permissions.ts';
import {
  DESKS_PER_BLOCK,
  MAX_LEVEL,
  PROVIDERS,
  XP_FOR_LEVEL,
  headcountCap,
  seatCeiling,
  type AllowRule,
  type BlockId,
  type ClientMessage,
  type Company,
  type CompanySettings,
  type Employee,
  type EmployeeRole,
  type EmployeeId,
  type EmployeeStatus,
  type HarnessStatus,
  type MeetingDoor,
  type ModelCatalog,
  type ModelId,
  type PermissionMode,
  type PermissionPolicy,
  type ProjectBlock,
  type Provider,
  type Question,
  type QuestionId,
  type Snapshot,
  type Subagent,
  type TaskBoardConfig,
  type TaskBoardState,
  type TaskProvider,
} from '../../shared/protocol.ts';
import { loginCursor } from './adapters/cursor.ts';
import { HARNESSES } from './adapters/index.ts';
import type { EmployeeSession, SessionHost } from './adapters/types.ts';
import { logger } from './debug.ts';
import { Inbox, type Left } from './inbox.ts';
import type { OfficeMcp } from './mcp.ts';
import type { MemoryStore } from './memory.ts';
import { TaskBoardService } from './task-board.ts';

const XP_PER_TASK = 10;
const XP_PER_QUICK_ANSWER = 3;
const QUICK_ANSWER_MS = 120_000;

export const MEETING_DND_RESPONSE =
  'The owner is in a meeting with the door closed. Do not proceed on their behalf. Wait until the door reopens, or continue a parallel task and ask again when context is available.';

const FIRST_NAMES = [
  'Ada', 'Ben', 'Cleo', 'Dana', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Luz',
  'Milo', 'Nia', 'Otto', 'Pia', 'Quin', 'Rui', 'Sol', 'Tess', 'Uma', 'Vic', 'Wren', 'Zoe',
];

const BLOCK_COLORS = ['#5b8def', '#f2a541', '#4fb286', '#c77dd4', '#ef6f6c', '#3fb8c9', '#d4b483', '#8b9cf0'];

export class OfficeError extends Error {}

export type OfficeEvents = {
  changed(): void;
  said(employeeId: EmployeeId, text: string): void;
  log(employeeId: EmployeeId, line: string, at: number): void;
  failed?(message: string): void;
};

// The things every session leans on, started before the first employee so a session can connect the moment it is built.
export type OfficeServices = {
  mcp: OfficeMcp;
  memory: MemoryStore;
  taskBoards?: TaskBoardService;
  openUrl?: (url: string) => void | Promise<void>;
};

// Where a blocked employee goes when the last question is answered. The adapter keeps reporting while the card is up
// (a subagent finishes, the turn ends), and those reports land here so the card stays put.
type Resume = { status: EmployeeStatus; activity: string; activityReported: boolean };

const debug = logger('office');

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const describeQuestion = (q: Question): string =>
  q.kind === 'permission'
    ? `Asking permission: ${q.tool} ${short(q.detail, 120)}`
    : `Asking the boss: ${q.text}${q.options ? ` [${q.options.join(' / ')}]` : ''}`;

const ruleLabel = (rule: AllowRule): string => {
  switch (rule.kind) {
    case 'command':
      return rule.prefix;
    case 'exact':
      return rule.command;
    case 'tool':
      return rule.name;
  }
};

export const levelForXp = (xp: number): number => {
  let level = 1;
  for (let l = 1; l <= MAX_LEVEL; l++) if (xp >= XP_FOR_LEVEL[l]!) level = l;
  return level;
};

const newId = <T extends string>() => randomUUID() as T;

// The one form a folder is stored and compared in, so two spellings of a path cannot make two blocks.
function canonicalDir(path: string): string {
  if (!isAbsolute(path)) throw new OfficeError(`${path} is not an absolute folder path`);
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // a missing path and a file get the same answer below
  }
  throw new OfficeError(`${path} is not a folder that exists`);
}

function githubRemote(cwd: string): string | undefined {
  try {
    const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000 }).trim();
    const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    if (ssh) return `https://github.com/${ssh[1]}`;
    const url = new URL(remote);
    if (url.hostname !== 'github.com') return undefined;
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return path.split('/').length === 2 ? `https://github.com/${path}` : undefined;
  } catch {
    return undefined;
  }
}

function seed(): Company {
  const requested = Number.parseInt(process.env.OFFICE_START_LEVEL ?? '1', 10);
  const level = Math.min(Math.max(Number.isNaN(requested) ? 1 : requested, 1), MAX_LEVEL);
  return {
    name: 'Gazapina Labs',
    level,
    xp: XP_FOR_LEVEL[level],
    settings: { seats: seatCeiling(level), defaultModels: {}, defaultPermissions: 'inherit' },
    blocks: [],
    employees: [],
  };
}

// What company.json can hold: a company from before models, permissions and settings existed, or from after.
type StoredEmployee = Omit<Employee, 'model' | 'permissions' | 'subagents' | 'role'> & Partial<Pick<Employee, 'model' | 'permissions' | 'role'>>;
type StoredCompany = Omit<Company, 'settings' | 'employees'> & { settings?: Partial<CompanySettings>; employees: StoredEmployee[] };

// Every field added after the first release gets its default here and nowhere else, so an old file and a new one
// load to the same company, and saving what this returns is the same file again.
function migrate(c: StoredCompany): Company {
  const settings: CompanySettings = {
    seats: c.settings?.seats ?? seatCeiling(c.level),
    defaultModels: c.settings?.defaultModels ?? {},
    defaultPermissions: c.settings?.defaultPermissions ?? 'inherit',
  };
  return {
    ...c,
    settings,
    blocks: c.blocks.map((b) => ({ ...b, githubRepo: b.githubRepo ?? githubRemote(b.cwd) })),
    employees: c.employees.map((e) => ({
      ...e,
      role: e.role ?? 'employee',
      model: e.model ?? HARNESSES[e.provider].defaultModel(),
      permissions: e.permissions ?? { mode: settings.defaultPermissions, alwaysAllow: [] },
      subagents: [],
    })),
  };
}

function load(file: string): Company | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  // Only this process writes the file, so a shape check is enough; anything odd falls back to a fresh seed.
  const c = raw as Partial<StoredCompany> | null;
  if (!c || typeof c.name !== 'string' || typeof c.level !== 'number' || typeof c.xp !== 'number') return undefined;
  if (!Array.isArray(c.blocks) || !Array.isArray(c.employees)) return undefined;
  return migrate(c as StoredCompany);
}

// Subagents belong to a running session, so they are never written.
function save(file: string, company: Company) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const stored = { ...company, employees: company.employees.map(({ subagents: _, ...e }) => e) };
  writeFileSync(tmp, JSON.stringify(stored, null, 2));
  renameSync(tmp, file);
}

export class Office {
  private company: Company;
  // Deliberately not persisted with company.json. Every app session starts with an open door.
  private meetingDoor: MeetingDoor = 'open';
  private sessions = new Map<EmployeeId, EmployeeSession>();
  // Every question an employee is waiting on. The employee's status shows the front of their line.
  private inbox = new Inbox({ headChanged: (id, head, left) => this.onHeadChanged(id, head, left) });
  private resumes = new Map<EmployeeId, Resume>();
  // What each harness offered the last time the owner asked. It is about this machine, not the company, so a reset keeps it.
  private catalogs: Record<Provider, ModelCatalog> = Object.fromEntries((Object.keys(PROVIDERS) as Provider[]).map((provider) => [provider, { kind: 'unknown' }])) as Record<Provider, ModelCatalog>;
  private readonly dataFile: string;
  private readonly harnesses: Record<Provider, HarnessStatus>;
  private readonly events: OfficeEvents;
  private readonly services: OfficeServices & { taskBoards: TaskBoardService };
  private readonly taskBoards = new Map<BlockId, TaskBoardState>();
  private cursorLogin?: Promise<void>;

  constructor(dataFile: string, harnesses: Record<Provider, HarnessStatus>, events: OfficeEvents, services: OfficeServices) {
    this.dataFile = dataFile;
    this.harnesses = harnesses;
    this.events = events;
    this.services = { ...services, taskBoards: services.taskBoards ?? new TaskBoardService() };
    this.services.taskBoards.setOnChange(() => {
      this.events.changed();
      for (const block of this.company.blocks) {
        if (block.taskBoard?.sources.some((source) => source.provider === 'linear')) void this.refreshTaskBoard(block.id);
      }
    });
    this.company = load(dataFile) ?? seed();
    for (const e of this.company.employees) {
      if (e.status.kind === 'working' || e.status.kind === 'blocked_on_owner') {
        e.status = { kind: 'idle' };
        e.activity = 'Back from a break (app restarted)';
      }
      this.startSession(e);
    }
    save(dataFile, this.company);
    for (const block of this.company.blocks) if (block.taskBoard?.sources.length) void this.refreshTaskBoard(block.id);
  }

  snapshot(): Snapshot {
    return {
      type: 'snapshot', company: this.company, harnesses: this.harnesses, catalogs: this.catalogs, meetingDoor: this.meetingDoor,
      taskBoards: Object.fromEntries(this.taskBoards), taskConnections: this.services.taskBoards.connectionStates(),
    };
  }

  shutdown() {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
    void this.services.taskBoards.close();
  }

  handle(msg: ClientMessage): void {
    switch (msg.type) {
      case 'hire':
        return this.hire(msg.provider, msg.blockId, msg.name, msg.model, msg.role, msg.bypassLimit);
      case 'fire':
        return this.fire(msg.employeeId);
      case 'create_block':
        return this.createBlock(msg.cwd, msg.name, msg.githubRepo);
      case 'update_block':
        return this.updateBlock(msg.blockId, msg.name, msg.cwd, msg.githubRepo);
      case 'remove_block':
        return this.removeBlock(msg.blockId);
      case 'configure_task_board':
        return this.configureTaskBoard(msg.blockId, msg.config);
      case 'configure_linear_board':
        return this.configureLinearBoard(msg.blockId, msg.url);
      case 'refresh_task_board':
        return void this.refreshTaskBoard(msg.blockId);
      case 'connect_task_provider':
        this.services.taskBoards.connect(msg.provider);
        this.events.changed();
        return;
      case 'configure_task_provider':
        this.services.taskBoards.configureCronoSpark(msg.apiKey, msg.userId);
        this.events.changed();
        return;
      case 'assign_task':
        return this.assignTask(msg.blockId, msg.taskId, msg.employeeId);
      case 'assign':
        return this.assign(msg.employeeId, msg.task);
      case 'answer':
        return this.answer(msg.employeeId, msg.questionId, msg.text, msg.always);
      case 'interject': {
        const e = this.employee(msg.employeeId);
        // A boss speaking to someone who is waiting on a decision is the decision.
        if (e.status.kind === 'blocked_on_owner') return this.answer(e.id, e.status.question.id, msg.text);
        this.assertFolderExists(e);
        return this.sessionOf(e).interject(msg.text, msg.style);
      }
      case 'meeting_door':
        return this.setMeetingDoor(msg.state);
      case 'load_models':
        return this.loadModels(msg.provider);
      case 'login_cursor':
        return void this.loginWithCursor();
      case 'set_model':
        return this.setModel(msg.employeeId, msg.model);
      case 'set_permissions':
        return this.setPermissions(msg.employeeId, msg.mode);
      case 'remove_allow_rule':
        return this.removeAllowRule(msg.employeeId, msg.rule);
      case 'fresh_session':
        return this.freshSession(msg.employeeId);
      case 'reset_company':
        return this.reset();
      default: {
        const unreachable: never = msg;
        throw new OfficeError(`Unhandled message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private commit() {
    save(this.dataFile, this.company);
    this.events.changed();
  }

  private employee(id: EmployeeId): Employee {
    const e = this.company.employees.find((x) => x.id === id);
    if (!e) throw new OfficeError(`No such employee ${id}`);
    return e;
  }

  private block(id: BlockId): ProjectBlock {
    const b = this.company.blocks.find((x) => x.id === id);
    if (!b) throw new OfficeError(`No such block ${id}`);
    return b;
  }

  private configureTaskBoard(blockId: BlockId, config: TaskBoardConfig) {
    const block = this.block(blockId);
    const sources = config.sources.map((source) => ({ provider: source.provider, projectId: source.projectId.trim(), ...(source.label?.trim() ? { label: source.label.trim() } : {}) }));
    if (sources.some((source) => !source.projectId)) throw new OfficeError('Each task board source needs a project id');
    const seen = new Set<string>();
    if (sources.some((source) => { const key = `${source.provider}:${source.projectId}`; if (seen.has(key)) return true; seen.add(key); return false; })) throw new OfficeError('A task board source is duplicated');
    block.taskBoard = { sources };
    this.commit();
    void this.refreshTaskBoard(blockId);
  }

  private configureLinearBoard(blockId: BlockId, url: string) {
    const block = this.block(blockId);
    const parsed = new URL(url.trim());
    if (!/^(www\.)?linear\.app$/i.test(parsed.hostname)) throw new OfficeError('Linear board URL must be on linear.app');
    block.linearBoardUrl = parsed.toString();
    this.commit();
  }

  private async refreshTaskBoard(blockId: BlockId) {
    const block = this.block(blockId);
    const previous = this.taskBoards.get(blockId);
    this.taskBoards.set(blockId, { kind: 'loading', cards: previous?.cards ?? [], ...(previous && 'lastFetchedAt' in previous && previous.lastFetchedAt ? { lastFetchedAt: previous.lastFetchedAt } : {}) });
    this.events.changed();
    const result = await this.services.taskBoards.fetchSources(block.taskBoard?.sources ?? []);
    if (!this.company.blocks.includes(block)) return;
    const now = Date.now();
    this.taskBoards.set(blockId, result.errors.length && !result.cards.length
      ? { kind: 'error', cards: result.cards, message: result.errors.join(' ') }
      : { kind: 'ready', cards: result.cards, lastFetchedAt: now });
    this.events.changed();
  }

  private assignTask(blockId: BlockId, taskId: string, employeeId: EmployeeId) {
    const block = this.block(blockId);
    const employee = this.employee(employeeId);
    if (employee.blockId !== block.id) throw new OfficeError(`${employee.name} does not work in ${block.name}`);
    const card = this.taskBoards.get(blockId)?.cards.find((candidate) => candidate.id === taskId);
    if (!card) throw new OfficeError('That ticket is no longer on the board. Refresh and try again.');
    const link = card.url ? ` ${card.url}` : '';
    this.assign(employeeId, `Work on ${card.identifier}: ${card.title} [${card.sourceLabel}]${link}`);
  }

  private sessionOf(e: Employee): EmployeeSession {
    const s = this.sessions.get(e.id);
    if (!s) throw new OfficeError(`${e.name} has no session`);
    return s;
  }

  private addXp(n: number) {
    this.company.xp += n;
    this.company.level = levelForXp(this.company.xp);
    this.commit();
  }

  private startSession(employee: Employee) {
    const block = this.block(employee.blockId);
    // Whatever the last session had running died with it.
    employee.subagents = [];
    let session: EmployeeSession | undefined;
    // A stopped session (fired, reset, block moved) can still have a message in flight.
    // Dropping its callbacks here keeps it from touching a newer company.
    const live =
      <A extends unknown[]>(f: (...a: A) => void) =>
      (...a: A) => {
        if (this.sessions.get(employee.id) === session) f(...a);
      };
    const create = HARNESSES[employee.provider].session;
    if (!create) {
      // Only reachable from a hand-edited company file: hire refuses providers that are not ready.
      employee.status = { kind: 'error', message: `${PROVIDERS[employee.provider].label} is not connected to the office yet` };
      return;
    }
    const notebook = this.services.memory.notebook({ employeeId: employee.id, blockId: block.id, provider: employee.provider });
    const ask: SessionHost['ask'] = (body, signal) => {
      if (this.sessions.get(employee.id) !== session) return Promise.resolve('');
      // Normal decisions get an immediate contextual answer while the owner is in a meeting. Permission
      // questions are still real inbox entries: they stay blocked and hidden until the door opens.
      if (this.meetingDoor === 'closed' && body.kind === 'ask') return Promise.resolve(MEETING_DND_RESPONSE);
      // Always allow is the office's, so every harness gets it: a covered request never reaches the owner.
      if (body.kind === 'permission') {
        const rule = employee.permissions.alwaysAllow.find((r) => covers(r, body));
        if (rule) {
          this.events.log(employee.id, `Allowed by your rule "${ruleLabel(rule)}": ${body.tool} ${short(body.detail, 120)}`, Date.now());
          return Promise.resolve(ALLOW_ANSWER);
        }
      }
      return this.inbox.ask(employee.id, body, signal);
    };
    // Whatever harness the employee runs on, these are the only tools it gets from the office, and the URL says whose they are.
    const url = this.services.mcp.attach(employee.id, {
      ask,
      drawDiagram: (title, mermaid) => {
        block.whiteboard = { title, mermaid, by: employee.id, at: Date.now() };
        this.commit();
      },
      openBoard: async (title, target) => {
        const page = await boardPage(block.cwd, target);
        block.whiteboard = { title, mermaid: '', page, by: employee.id, at: Date.now() };
        this.commit();
      },
      delegateToTeammate: async (target, task) => this.delegateToTeammate(employee, target, task),
      memory: notebook,
    });
    const host: SessionHost = {
      employee,
      block,
      companyName: this.company.name,
      get model() {
        return employee.model;
      },
      get permissions() {
        return employee.permissions;
      },
      setStatus: live((status) => this.report(employee, { status })),
      setActivity: live((text) => this.report(employee, { activity: text })),
      setSessionId: live((id) => {
        employee.sessionId = id;
        this.commit();
      }),
      said: live((text) => this.events.said(employee.id, text)),
      log: live((line) => this.events.log(employee.id, line, Date.now())),
      ask,
      mcp: { url, name: 'office' },
      memoryDigest: () => notebook.digest(block.name),
      // F2 reads the rule files here.
      rules: () => '',
      taskCompleted: live(() => {
        employee.completedAt = Date.now();
        this.addXp(XP_PER_TASK);
      }),
      subagentStarted: live((subagent) => this.startSubagent(employee, subagent)),
      subagentFinished: live((id) => this.finishSubagent(employee, id)),
    };
    session = create(host);
    this.sessions.set(employee.id, session);
  }

  private startSubagent(e: Employee, subagent: Subagent) {
    if (e.subagents.some((s) => s.id === subagent.id)) return;
    // A doll sits on its parent, so one whose parent is not here sits on the desk.
    const parentId = e.subagents.some((s) => s.id === subagent.parentId) ? subagent.parentId : null;
    e.subagents.push({ ...subagent, parentId });
    this.commit();
  }

  private finishSubagent(e: Employee, id: string) {
    // A parent is always listed before its children, so one pass finds everything under it.
    const ended = new Set([id]);
    for (const s of e.subagents) if (s.parentId !== null && ended.has(s.parentId)) ended.add(s.id);
    if (!e.subagents.some((s) => ended.has(s.id))) return;
    e.subagents = e.subagents.filter((s) => !ended.has(s.id));
    this.commit();
  }

  private stopSession(id: EmployeeId) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    s?.stop();
    // Cancels whatever the harness still has in flight over MCP, then releases everyone waiting on the owner.
    this.services.mcp.detach(id);
    this.inbox.clear(id);
    this.resumes.delete(id);
  }

  // What an adapter says about its employee. With a question waiting on the owner the card stays up, and the report
  // is kept for when the last question is answered.
  private report(e: Employee, update: { status: EmployeeStatus } | { activity: string }) {
    const resume = this.resumes.get(e.id);
    if (resume) {
      if ('status' in update) resume.status = update.status;
      else Object.assign(resume, { activity: update.activity, activityReported: true });
      return;
    }
    if ('status' in update) e.status = update.status;
    else e.activity = update.activity;
    this.commit();
  }

  // The front of an employee's line changed. Show it, or, with nothing left waiting, send them back to where they were.
  private onHeadChanged(id: EmployeeId, head: Question | undefined, left: Left | undefined) {
    const e = this.company.employees.find((x) => x.id === id);
    if (!e) return;
    if (head) {
      const resume: Resume = this.resumes.get(id) ?? {
        status: e.status.kind === 'blocked_on_owner' ? { kind: 'idle' } : e.status,
        activity: e.activity,
        activityReported: false,
      };
      this.resumes.set(id, resume);
      e.status = { kind: 'blocked_on_owner', task: resume.status.kind === 'working' ? resume.status.task : resume.activity, question: head };
      e.activity = 'Asking the boss';
      this.events.log(id, describeQuestion(head), Date.now());
      return this.commit();
    }
    const resume = this.resumes.get(id);
    this.resumes.delete(id);
    if (!resume) return;
    e.status = resume.status;
    // A permission, or a question taken back, returns to the step it was on. An answer to a question is just an answer.
    e.activity = left?.answered && left.question.kind === 'ask' && !resume.activityReported ? 'Got the answer, back to work' : resume.activity;
    this.commit();
  }

  private hire(provider: Provider, blockId: BlockId, requestedName?: string, requestedModel?: ModelId, role: EmployeeRole = 'employee', bypassLimit = false) {
    const { company } = this;
    const block = this.block(blockId);
    const harness = this.harnesses[provider];
    if (harness.kind !== 'ready') {
      const { label } = PROVIDERS[provider];
      const why =
        harness.kind === 'missing'
          ? `${label} is not installed on this machine.`
          : harness.kind === 'needs_login'
            ? `Log in with ${label} to hire someone.`
            : `${label} is installed but not connected to the office yet.`;
      throw new OfficeError(why);
    }
    const cap = headcountCap(company.level);
    if (!bypassLimit && company.employees.length >= cap) {
      throw new OfficeError(`Headcount cap reached (${cap} at level ${company.level}). Earn XP to grow the company.`);
    }
    const taken = new Set(company.employees.filter((e) => e.blockId === blockId).map((e) => e.desk));
    let desk = 0;
    while (taken.has(desk)) desk++;
    if (!bypassLimit && desk >= DESKS_PER_BLOCK && Number.isFinite(cap)) throw new OfficeError(`${block.name} has no free desk at this level`);

    const employee: Employee = {
      id: newId<EmployeeId>(),
      name: requestedName?.trim() || this.pickName(),
      provider,
      role,
      blockId,
      desk,
      status: { kind: 'idle' },
      activity: 'Just started, settling in at my desk',
      model: requestedModel ?? company.settings.defaultModels[provider] ?? HARNESSES[provider].defaultModel(),
      permissions: { mode: company.settings.defaultPermissions, alwaysAllow: [] },
      subagents: [],
      hiredAt: Date.now(),
    };
    company.employees.push(employee);
    this.startSession(employee);
    this.commit();
  }

  private pickName(): string {
    const used = new Set(this.company.employees.map((e) => e.name));
    const free = FIRST_NAMES.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(Math.random() * free.length)]!;
    let i = 2;
    while (used.has(`Ada ${i}`)) i++;
    return `Ada ${i}`;
  }

  private fire(id: EmployeeId) {
    this.dismiss(this.employee(id));
    this.commit();
  }

  private dismiss(e: Employee) {
    this.stopSession(e.id);
    this.company.employees = this.company.employees.filter((x) => x.id !== e.id);
    // Their own notes go to alumni/. The block's notes stay for whoever works there next.
    this.services.memory.archive(e.id).catch((err) => console.error(`Could not archive ${e.name}'s notes:`, err));
  }

  private removeBlock(blockId: BlockId) {
    const block = this.block(blockId);
    for (const e of this.company.employees.filter((x) => x.blockId === blockId)) this.dismiss(e);
    this.company.blocks = this.company.blocks.filter((b) => b !== block);
    this.taskBoards.delete(blockId);
    this.commit();
  }

  private createBlock(dir: string, name?: string, githubRepo?: string) {
    const cwd = canonicalDir(dir);
    this.assertFolderFree(cwd);
    const { blocks } = this.company;
    const slots = new Set(blocks.map((b) => b.slot));
    let slot = 0;
    while (slots.has(slot)) slot++;
    const usedColors = new Set(blocks.map((b) => b.color));
    const color = BLOCK_COLORS.find((c) => !usedColors.has(c)) ?? BLOCK_COLORS[slot % BLOCK_COLORS.length]!;
    const repo = githubRepo?.trim().replace(/\/$/, '') || githubRemote(cwd);
    blocks.push({ id: newId<BlockId>(), name: name?.trim() || basename(cwd), cwd, color, slot, ...(repo && { githubRepo: repo }) });
    this.commit();
  }

  private assertFolderFree(cwd: string, except?: BlockId) {
    const clash = this.company.blocks.find((b) => b.cwd === cwd && b.id !== except);
    if (clash) throw new OfficeError(`${clash.name} already works in ${cwd}.`);
  }

  private updateBlock(blockId: BlockId, name?: string, cwd?: string, githubRepo?: string) {
    const block = this.block(blockId);
    if (name) block.name = name.trim();
    if (githubRepo !== undefined) block.githubRepo = githubRepo.trim().replace(/\/$/, '') || undefined;
    if (cwd) {
      const next = canonicalDir(cwd);
      if (next !== block.cwd) {
        this.assertFolderFree(next, blockId);
        const members = this.company.employees.filter((e) => e.blockId === blockId);
        const busy = members.find((e) => e.status.kind === 'working' || e.status.kind === 'blocked_on_owner');
        if (busy) throw new OfficeError(`${busy.name} is busy. Move ${block.name} when everyone is idle.`);
        block.cwd = next;
        // Claude sessions are stored per directory, so an old sessionId cannot be resumed in the new one.
        for (const e of members) {
          this.stopSession(e.id);
          delete e.sessionId;
          this.startSession(e);
        }
      }
    }
    this.commit();
  }

  private assign(id: EmployeeId, task: string) {
    const e = this.employee(id);
    if (e.status.kind === 'working' || e.status.kind === 'blocked_on_owner') {
      throw new OfficeError(`${e.name} is busy. Interject to redirect them.`);
    }
    this.assertFolderExists(e);
    delete e.completedAt;
    this.sessionOf(e).assign(task.trim());
  }

  // The folder is checked when the block is made, but it can be deleted later. A harness started there fails with its
  // own misleading error: Claude's blames its binary.
  private assertFolderExists(e: Employee) {
    const block = this.block(e.blockId);
    if (!existsSync(block.cwd)) throw new OfficeError(`${block.name}'s folder ${block.cwd} no longer exists. Restore it, or make a new block on a folder that does.`);
  }

  private async delegateToTeammate(orchestrator: Employee, target: string | undefined, task: string): Promise<string> {
    if ((orchestrator.role ?? 'employee') !== 'orchestrator') return 'Only the block orchestrator can delegate team tasks.';
    const teammates = this.company.employees.filter((candidate) => candidate.blockId === orchestrator.blockId && candidate.id !== orchestrator.id);
    const normalized = target?.trim().toLocaleLowerCase();
    const teammate = normalized
      ? teammates.find((candidate) => candidate.name.toLocaleLowerCase() === normalized)
      : teammates.find((candidate) => candidate.status.kind === 'idle');
    if (!teammate) return normalized ? `No teammate named ${target} works in this block.` : 'Every teammate is busy or this block has no other employees.';
    if (teammate.status.kind === 'working' || teammate.status.kind === 'blocked_on_owner') return `${teammate.name} is busy. Ask them to finish or choose another teammate.`;
    this.assign(teammate.id, task.trim());
    return `Assigned ${teammate.name}: ${task.trim()}`;
  }

  private answer(id: EmployeeId, questionId: QuestionId, text: string, always = false) {
    const e = this.employee(id);
    if (e.status.kind !== 'blocked_on_owner' || e.status.question.id !== questionId) {
      throw new OfficeError(`${e.name} has no open question ${questionId}`);
    }
    const { question } = e.status;
    if (!this.inbox.answer(id, questionId, text)) throw new OfficeError(`${e.name} has no open question ${questionId}`);
    debug(`owner answered ${e.name} after ${((Date.now() - question.askedAt) / 1000).toFixed(1)}s: ${JSON.stringify(short(text, 120))}`);
    if (always && question.kind === 'permission' && isAllow(text)) this.allowAlways(e, question);
    if (Date.now() - question.askedAt <= QUICK_ANSWER_MS) this.addXp(XP_PER_QUICK_ANSWER);
  }

  // Always allow on a card. A command too tangled for a safe rule is allowed this once, and the log says so.
  private allowAlways(e: Employee, question: PermissionBody) {
    const rule = ruleFor(question);
    if (!rule) return this.events.log(e.id, `No rule can stand for that command, so it was allowed only this once: ${short(question.detail, 120)}`, Date.now());
    if (e.permissions.alwaysAllow.some((r) => sameRule(r, rule))) return;
    this.changePermissions(e, { alwaysAllow: [...e.permissions.alwaysAllow, rule] }, `Always allow: ${ruleLabel(rule)}`);
  }

  private loginWithCursor() {
    if (this.cursorLogin) return;
    const open = this.services.openUrl;
    this.cursorLogin = loginCursor((url) => {
      if (!open) throw new Error('This office cannot open a browser.');
      return open(url);
    })
      .then((status) => {
        this.harnesses.cursor = status;
        this.events.changed();
      })
      .catch((err: unknown) => this.events.failed?.(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.cursorLogin = undefined;
      });
  }

  private loadModels(provider: Provider) {
    const harness = HARNESSES[provider];
    if (this.harnesses[provider].kind !== 'ready' || !harness.listModels || this.catalogs[provider].kind === 'loading') return;
    this.setCatalog(provider, { kind: 'loading' });
    harness.listModels().then(
      (catalog) => this.setCatalog(provider, catalog),
      (err: unknown) => this.setCatalog(provider, { kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }

  private setCatalog(provider: Provider, catalog: ModelCatalog) {
    this.catalogs[provider] = catalog;
    this.events.changed();
  }

  private setModel(id: EmployeeId, model: ModelId) {
    const e = this.employee(id);
    e.model = model;
    this.events.log(id, `Model: ${model}, from the next turn`, Date.now());
    this.sessions.get(id)?.setModel(model);
    this.commit();
  }

  private setPermissions(id: EmployeeId, mode: PermissionMode) {
    this.changePermissions(this.employee(id), { mode }, `Permissions: ${mode}`);
  }

  private removeAllowRule(id: EmployeeId, rule: AllowRule) {
    const e = this.employee(id);
    const alwaysAllow = e.permissions.alwaysAllow.filter((r) => !sameRule(r, rule));
    if (alwaysAllow.length !== e.permissions.alwaysAllow.length) this.changePermissions(e, { alwaysAllow }, `Rule removed: ${ruleLabel(rule)}`);
  }

  // The one way a policy changes. Each change is a new object, so nothing that was handed the old policy sees it move.
  private changePermissions(e: Employee, change: Partial<PermissionPolicy>, logLine: string) {
    e.permissions = { ...e.permissions, ...change };
    this.events.log(e.id, logLine, Date.now());
    this.sessions.get(e.id)?.permissionsChanged(e.permissions);
    this.commit();
  }

  private setMeetingDoor(state: MeetingDoor) {
    if (this.meetingDoor === state) return;
    this.meetingDoor = state;
    this.events.changed();
  }

  // The old session stops with its questions. With no sessionId left, the new one has no conversation to resume.
  // The employee keeps their notes, model and rules.
  private freshSession(id: EmployeeId) {
    const e = this.employee(id);
    this.stopSession(id);
    delete e.sessionId;
    e.status = { kind: 'idle' };
    e.activity = 'Started a fresh session';
    this.events.log(id, 'Started a fresh session', Date.now());
    this.startSession(e);
    this.commit();
  }

  private reset() {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
    this.company = seed();
    this.meetingDoor = 'open';
    this.commit();
    this.services.memory.wipe().catch((err) => console.error('Could not wipe memory:', err));
  }
}
