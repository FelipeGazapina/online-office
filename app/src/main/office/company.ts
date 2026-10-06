import { createAcknowledger, type Acknowledger } from './ack.ts';
import { isPlainOrder, type OwnerIntent } from './owner-intent.ts';
import { boardPage } from './board.ts';
import { folderArtifacts } from './mail-artifacts.ts';
import { commitsAhead, createWorkspace, integrate, isGitRepo, removeWorkspace, syncWorkspace, workspaceArtifacts } from './workspace.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ALLOW_ANSWER, covers, isAllow, ruleFor, sameRule, type PermissionBody } from '../../shared/permissions.ts';
import {
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
  type TaskBoardSource,
} from '../../shared/protocol.ts';
import type { LegacySources } from '../../shared/tasks.ts';
import { applyOps, BuildHistory, deskOf, encodeBuilding, freeDesk, legacyBuilding, parseBuilding, placeDesk, teamKit, ITEM_DEFS } from '../../shared/space/index.ts';
import type { Building, BuildOp, EmployeeId as SpaceEmployeeId, ItemId, SpaceContext, Violation } from '../../shared/space/index.ts';
import type { ActorId, ConvoKey, LedgerEntry, MailView, MessageId } from '../../shared/mail.ts';
import { HARNESSES } from './adapters/index.ts';
import type { EmployeeSession, SessionHost } from './adapters/types.ts';
import { logger } from './debug.ts';
import { OfficeError } from './error.ts';
import { Inbox, type Left } from './inbox.ts';
import { defaultIds, Mailroom, type HireSpec, type Hired, type Member } from './mail.ts';
import { mailTools } from './mail-tools.ts';
import type { OfficeMcp } from './mcp.ts';
import type { MemoryStore } from './memory.ts';
import { TaskBoardService } from './task-board.ts';
import { Tasks } from './tasks.ts';
import { trace } from './trace.ts';

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

export type OfficeEvents = {
  changed(): void;
  said(employeeId: EmployeeId, text: string): void;
  log(employeeId: EmployeeId, line: string, at: number): void;
  building(building: Building, rev: number): void;
  rejected(violations: readonly Violation[]): void;
  // Mail changed, or an employee is writing a bubble. Both go past the snapshot coalescer.
  mail?(view: MailView): void;
  stream?(employeeId: EmployeeId, replyingTo: MessageId | null, delta: string, done: boolean): void;
  history?(convo: ConvoKey, messages: import('../../shared/mail.ts').Message[], hasMore: boolean): void;
  // Something the owner must hear about that no request is open for, like a folder that was deleted.
  error?(message: string): void;
};

// The things every session leans on, started before the first employee so a session can connect the moment it is built.
export type OfficeServices = { mcp: OfficeMcp; memory: MemoryStore; taskBoards?: TaskBoardService; acker?: Pick<Acknowledger, 'warm' | 'ack' | 'stop'> & Partial<Pick<Acknowledger, 'triage'>> };

// Where a blocked employee goes when the last question is answered. The adapter keeps reporting while the card is up
// (a subagent finishes, the turn ends), and those reports land here so the card stays put.
type Resume = { status: EmployeeStatus; activity: string; activityReported: boolean };

const debug = logger('office');

type HireRequest = { provider: Provider; blockId: BlockId; name?: string; model?: ModelId; role?: EmployeeRole; bypassLimit?: boolean; deskId?: ItemId };

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

function seed(): Loaded {
  const requested = Number.parseInt(process.env.OFFICE_START_LEVEL ?? '1', 10);
  const level = Math.min(Math.max(Number.isNaN(requested) ? 1 : requested, 1), MAX_LEVEL);
  const company: Company = {
    name: 'Gazapina Labs',
    level,
    xp: XP_FOR_LEVEL[level],
    settings: { seats: seatCeiling(level), defaultModels: {}, defaultPermissions: 'inherit' },
    blocks: [],
    employees: [],
  };
  return { company, building: legacyBuilding([], []).building, legacy: [] };
}

// What company.json can hold: a company from before models, permissions and settings existed, or from after.
type StoredEmployee = Omit<Employee, 'model' | 'permissions' | 'subagents' | 'role' | 'seat'> &
  Partial<Pick<Employee, 'model' | 'permissions' | 'role' | 'seat'>> & { desk?: number };
// A block of the old kind kept its task sources on itself. They are a board's now (shared/tasks.ts ensureBoards).
type StoredBlock = ProjectBlock & { taskBoard?: { sources?: TaskBoardSource[] } };
type StoredCompany = Omit<Company, 'settings' | 'employees' | 'blocks'> & { blocks: StoredBlock[]; settings?: Partial<CompanySettings>; employees: StoredEmployee[]; building?: unknown };

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
    blocks: c.blocks.map(({ taskBoard: _, ...b }) => ({ ...b, githubRepo: b.githubRepo ?? githubRemote(b.cwd) })),
    employees: c.employees.map(({ desk: _desk, ...e }) => ({
      ...e,
      seat: e.seat ?? null,
      role: e.role ?? 'employee',
      model: e.model ?? HARNESSES[e.provider].defaultModel(),
      permissions: e.permissions ?? { mode: settings.defaultPermissions, alwaysAllow: [] },
      subagents: [],
    })),
  };
}

const spaceCtx = (company: Company, seats: ReadonlyMap<SpaceEmployeeId, ItemId>): SpaceContext => ({
  blocks: new Set(company.blocks.map((b) => b.id)),
  employees: new Map(company.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats,
});

const seatsOf = (company: Company): Map<SpaceEmployeeId, ItemId> =>
  new Map(company.employees.flatMap((e) => (e.seat ? [[e.id, e.seat] as const] : [])));

// Gives every employee a desk of the right kind in their own block. A seat that is gone, shared or in the wrong
// block is dropped and the employee goes to the team's next free desk, or with `grow` to a new one beside the team.
function seatEveryone(company: Company, building: Building, grow = true): Building {
  const seats = new Map<SpaceEmployeeId, ItemId>();
  const ok = (e: Employee) => {
    const item = e.seat ? deskOf(building, new Map([[e.id, e.seat]]), e.id) : null;
    const kind = e.role === 'orchestrator' ? 'po_desk' : 'bench_desk';
    return !!item && ITEM_DEFS[item.def]?.kind === kind && item.blockId === e.blockId;
  };
  for (const e of company.employees) if (ok(e) && ![...seats.values()].includes(e.seat!)) seats.set(e.id, e.seat!);
  let b = building;
  for (const e of company.employees) {
    if (seats.has(e.id)) continue;
    const orchestrator = e.role === 'orchestrator';
    let desk = freeDesk(b, seats, e.blockId, orchestrator);
    if (!desk) {
      const put = grow && company.blocks.some((x) => x.id === e.blockId) ? placeDesk(b, e.blockId, orchestrator, spaceCtx(company, seats)) : null;
      const applied = put && applyOps(b, put, spaceCtx(company, seats));
      if (applied?.ok) {
        b = applied.building;
        desk = freeDesk(b, seats, e.blockId, orchestrator);
      }
    }
    if (desk) seats.set(e.id, desk.id);
  }
  for (const e of company.employees) e.seat = seats.get(e.id) ?? null;
  return b;
}

type Loaded = { company: Company; building: Building; legacy: LegacySources[] };

// A company.json from before the building keeps its desks: the static office becomes a building and every employee
// sits where the old desk index put them. Saving the result and loading it again changes nothing.
function load(file: string): Loaded | undefined {
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
  const stored = c as StoredCompany;
  const company = migrate(stored);
  let building: Building | undefined;
  if (stored.building !== undefined) {
    try {
      building = parseBuilding(stored.building);
    } catch (err) {
      console.warn(`company.json: ${err instanceof Error ? err.message : err}. Rebuilding the office from its teams.`);
    }
  }
  if (!building) {
    const legacy = legacyBuilding(
      company.blocks.map((b) => ({ id: b.id, slot: b.slot })),
      stored.employees.map((e) => ({ id: e.id, blockId: e.blockId, desk: e.desk ?? -1, orchestrator: (e.role ?? 'employee') === 'orchestrator' })),
    );
    building = legacy.building;
    for (const e of company.employees) e.seat = legacy.seats.get(e.id) ?? null;
  }
  const legacy = stored.blocks.flatMap((b) => (b.taskBoard?.sources?.length ? [{ blockId: b.id, sources: b.taskBoard.sources }] : []));
  return { company, building: seatEveryone(company, building), legacy };
}

// Subagents belong to a running session, so they are never written.
function save(file: string, company: Company, building: Building) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const stored = { ...company, employees: company.employees.map(({ subagents: _, ...e }) => e), building: encodeBuilding(building) };
  writeFileSync(tmp, JSON.stringify(stored, null, 2));
  renameSync(tmp, file);
}

function readLedger(file: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // Only this process writes the file. A line cut short by a crash is dropped.
  return raw.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as LedgerEntry] : [];
    } catch {
      return [];
    }
  });
}

export class Office {
  private company: Company;
  private building: Building;
  // Counts changes in this run, so the renderer can tell a building it already holds from a new one.
  private buildingRev = 1;
  private history = new BuildHistory();
  // Deliberately not persisted with company.json. Every app session starts with an open door.
  private meetingDoor: MeetingDoor = 'open';
  private sessions = new Map<EmployeeId, EmployeeSession>();
  // Every question an employee is waiting on. The employee's status shows the front of their line.
  private inbox = new Inbox({ headChanged: (id, head, left) => this.onHeadChanged(id, head, left) });
  private resumes = new Map<EmployeeId, Resume>();
  // What each harness offered the last time the owner asked. It is about this machine, not the company, so a reset keeps it.
  private catalogs: Record<Provider, ModelCatalog> = { 'claude-code': { kind: 'unknown' }, codex: { kind: 'unknown' }, hermes: { kind: 'unknown' } };
  private readonly dataFile: string;
  private readonly harnesses: Record<Provider, HarnessStatus>;
  private readonly events: OfficeEvents;
  private readonly services: OfficeServices & { taskBoards: TaskBoardService };
  private readonly tasks: Tasks;
  private readonly ledgerFile: string;
  private mail!: Mailroom;
  private readonly acker: Pick<Acknowledger, 'warm' | 'ack' | 'stop'> & Partial<Pick<Acknowledger, 'triage'>>;
  // Owner posts that wait for a triage answer, and the end of the line they keep their order in.
  private ownerPosts = { waiting: 0, tail: Promise.resolve(), closed: false };
  // The last thing each employee said in the turn they are on. It is the reply when the harness gives no final text.
  private lastSaid = new Map<EmployeeId, string>();

  constructor(dataFile: string, harnesses: Record<Provider, HarnessStatus>, events: OfficeEvents, services: OfficeServices) {
    this.dataFile = dataFile;
    this.harnesses = harnesses;
    this.events = events;
    this.acker = services.acker ?? createAcknowledger();
    this.services = { ...services, taskBoards: services.taskBoards ?? new TaskBoardService() };
    this.services.taskBoards.setOnChange(() => {
      this.events.changed();
      this.tasks.refreshWhere((board) => board.sources.some((source) => source.provider === 'linear'));
    });
    const loaded = load(dataFile) ?? seed();
    this.company = loaded.company;
    this.building = loaded.building;
    this.ledgerFile = dataFile.replace(/\.json$/, '') + '.mail.jsonl';
    const ledger = readLedger(this.ledgerFile);
    this.tasks = new Tasks(
      join(dirname(dataFile), 'tasks.json'),
      {
        now: () => Date.now(),
        newId: () => randomUUID(),
        mail: () => this.mail,
        blocks: () => this.company.blocks.map((b) => b.id),
        members: () => this.company.employees.map((e) => ({ id: e.id, name: e.name, blockId: e.blockId })),
        provider: this.services.taskBoards,
        changed: () => this.events.changed(),
      },
      ledger,
    );
    this.mail = this.openMail(ledger);
    // The boards are written before company.json drops the old per-block sources they came from.
    this.tasks.recover(this.company.blocks.map((b) => b.id), loaded.legacy);
    for (const e of this.company.employees) {
      if (e.status.kind === 'working' || e.status.kind === 'blocked_on_owner') {
        e.status = { kind: 'idle' };
        e.activity = 'Back from a break (app restarted)';
      }
      this.startSession(e);
      if (e.role === 'orchestrator') this.sessionOf(e).warm?.();
      if (e.provider === 'claude-code') this.acker.warm();
    }
    save(dataFile, this.company, this.building);
    this.tasks.refreshWhere((board) => board.sources.length > 0);
    // Sessions exist now, so whatever a crash left half delivered can go out again.
    this.mail.recoverOnStart();
    this.tasks.pushHours();
  }

  private openMail(ledger: LedgerEntry[]): Mailroom {
    const nameOf = (a: ActorId) => (a === 'owner' ? 'the owner' : a === 'mailroom' ? 'the office' : (this.company.employees.find((e) => e.id === a)?.name ?? 'someone who left'));
    return new Mailroom(
      {
        members: () => this.company.employees.map((e): Member => ({ id: e.id, name: e.name, role: e.role ?? 'employee', blockId: e.blockId, status: e.status.kind, ...('task' in e.status ? { doing: e.status.task } : {}) })),
        nameOf,
        deliver: (to, prompt, title) => this.deliver(to, prompt, title),
        steer: (to, text, style) => this.steer(to, text, style),
        hire: (from, spec) => this.hireFor(from, spec),
        artifacts: workspaceArtifacts(
          (who) => {
            const e = this.company.employees.find((x) => x.id === who);
            const block = e && this.company.blocks.find((b) => b.id === e.blockId);
            return e?.workspace && block ? { blockCwd: block.cwd, ws: e.workspace } : undefined;
          },
          folderArtifacts((who) => {
            const e = this.company.employees.find((x) => x.id === who);
            return e ? this.company.blocks.find((b) => b.id === e.blockId)?.cwd : undefined;
          }),
        ),
        integrate: (who, title) => this.integrateWork(who, title),
        arrived: (who) => {
          const e = this.company.employees.find((x) => x.id === who);
          const block = e && this.company.blocks.find((b) => b.id === e.blockId);
          if (e?.workspace && block) syncWorkspace(block.cwd, e.workspace, e.name, true);
        },
        branchOf: (who) => {
          const e = this.company.employees.find((x) => x.id === who);
          const block = e && this.company.blocks.find((b) => b.id === e.blockId);
          return e?.workspace && block ? { branch: e.workspace.branch, ahead: commitsAhead(block.cwd, e.workspace) } : undefined;
        },
        persist: (entry) => {
          mkdirSync(dirname(this.ledgerFile), { recursive: true });
          appendFileSync(this.ledgerFile, `${JSON.stringify(entry)}\n`);
          this.tasks.observe(entry);
        },
        changed: (view) => {
          this.events.mail?.(view);
          this.tasks.onMail();
          this.events.changed();
        },
        stream: (employeeId, replyingTo, delta, done) => this.events.stream?.(employeeId, replyingTo, delta, done),
        acknowledge: (to, request, onDelta) => {
          const e = this.company.employees.find((x) => x.id === to);
          const block = e && this.company.blocks.find((b) => b.id === e.blockId);
          if (!e || !block || request.kind !== 'request') return undefined;
          const teammates = this.company.employees.filter((x) => x.blockId === e.blockId && x.id !== e.id).map((x) => `${x.name} (${x.role ?? 'employee'})`);
          return this.acker.ack({ who: e.id, name: e.name, role: e.role ?? 'employee', company: this.company.name, block: block.name, teammates, request: request.text, question: request.intent === 'help' }, onDelta);
        },
        now: () => Date.now(),
        newId: defaultIds,
      },
      ledger,
    );
  }

  // A turn starts. The prompt is the chat transcript of what is waiting. A missing folder throws, and the mailroom settles those requests failed.
  private deliver(id: EmployeeId, prompt: string, title: string) {
    const e = this.employee(id);
    trace(id, 'deliver');
    try {
      this.assertFolderExists(e);
    } catch (err) {
      this.events.error?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
    // A worktree the owner deleted is rebuilt, and the session that stood in it restarts with it.
    if (e.workspace && !existsSync(e.workspace.path)) {
      this.stopSession(id);
      this.startSession(e);
    }
    delete e.completedAt;
    this.lastSaid.delete(id);
    const note = this.syncNote(e);
    trace(id, 'assign');
    this.sessionOf(e).assign(note + prompt, title);
  }

  // Every request starts from the block's latest integrated work. A conflict is left in the worktree and told to the employee.
  private syncNote(e: Employee): string {
    if (!e.workspace) return '';
    const block = this.block(e.blockId);
    const sync = syncWorkspace(block.cwd, e.workspace, e.name);
    if (sync.kind === 'conflict') {
      this.events.log(e.id, `Merging the block's latest code into ${e.workspace.branch} conflicts in ${sync.paths.join(', ')}`, Date.now());
      return `[Office note. The block folder moved on, and merging its latest code into your branch ${e.workspace.branch} conflicts in: ${sync.paths.join(', ')}. The merge is open in your worktree. Resolve those files and commit before anything else.]\n\n`;
    }
    if (sync.kind === 'skipped') return `[Office note. The block's latest code could not be merged into your branch (${sync.reason}). Work from what you have.]\n\n`;
    return '';
  }

  // The employee's own git worktree, made at hire (or on the first session of someone hired before worktrees). Not a git
  // repo, or git refusing, keeps the shared folder, and the log says so.
  private ensureWorkspace(e: Employee, block: ProjectBlock) {
    if (!existsSync(block.cwd)) return;
    if (!isGitRepo(block.cwd)) {
      this.events.log(e.id, `${block.name}'s folder is not a git repository, so ${e.name} works in the shared folder`, Date.now());
      return;
    }
    const had = e.workspace;
    try {
      e.workspace = createWorkspace(block.cwd, join(dirname(this.dataFile), 'worktrees', e.id), e.name);
    } catch (err) {
      delete e.workspace;
      this.events.log(e.id, `${err instanceof Error ? err.message : String(err)}. ${e.name} works in the shared folder`, Date.now());
      return;
    }
    // A harness session is stored per directory, so one from the shared folder cannot resume in the worktree.
    if (!had || had.path !== e.workspace.path) delete e.sessionId;
  }

  private integrateWork(id: EmployeeId, title: string) {
    const e = this.company.employees.find((x) => x.id === id);
    const block = e && this.company.blocks.find((b) => b.id === e.blockId);
    if (!e?.workspace || !block) return undefined;
    const result = integrate(block.cwd, e.workspace, e.name, title);
    if (result.kind === 'merged') this.events.log(id, `Merged ${result.branch} into ${block.name}`, Date.now());
    if (result.kind === 'held') this.events.log(id, `${e.name}'s work is on branch ${result.branch}, not merged into ${block.name}: ${result.reason}`, Date.now());
    if (result.kind === 'conflict') this.events.log(id, `${e.name}'s work on ${result.branch} conflicts with ${block.name} in ${result.paths.join(', ')}`, Date.now());
    return result;
  }

  // A boss speaking to someone who is waiting on a decision is the decision. Everyone else is told in the middle of the turn.
  private steer(id: EmployeeId, text: string, style: 'next' | 'now') {
    const e = this.employee(id);
    if (e.status.kind === 'blocked_on_owner') return this.answer(e.id, e.status.question.id, text);
    this.sessionOf(e).interject(text, style);
  }

  snapshot(): Snapshot {
    return {
      type: 'snapshot', company: this.company, harnesses: this.harnesses, catalogs: this.catalogs, meetingDoor: this.meetingDoor, buildingRev: this.buildingRev,
      ...this.tasks.view(Date.now()), taskConnections: this.services.taskBoards.connectionStates(), mail: this.mail.view(),
    };
  }

  buildingState(): { building: Building; rev: number } {
    return { building: this.building, rev: this.buildingRev };
  }

  shutdown() {
    this.ownerPosts.closed = true;
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
    this.acker.stop();
    void this.services.taskBoards.close();
  }

  handle(msg: ClientMessage): void {
    switch (msg.type) {
      case 'hire': {
        const { type: _, taskId, ...request } = msg;
        if (taskId) this.tasks.assertOfBlock(taskId, msg.blockId);
        const hired = this.hire(request);
        if (taskId) this.tasks.assign(taskId, hired.id);
        return;
      }
      case 'fire':
        return this.fire(msg.employeeId);
      case 'create_block':
        return this.createBlock(msg.cwd, msg.name, msg.githubRepo);
      case 'update_block':
        return this.updateBlock(msg.blockId, msg.name, msg.cwd, msg.githubRepo);
      case 'remove_block':
        return this.removeBlock(msg.blockId);
      case 'configure_linear_board':
        return this.configureLinearBoard(msg.blockId, msg.url);
      case 'create_board':
        this.tasks.createBoard(msg.blockId, msg.name, msg.spec);
        return this.events.changed();
      case 'update_board': {
        const { type: _, boardId, ...patch } = msg;
        this.tasks.updateBoard(boardId, patch);
        return this.events.changed();
      }
      case 'delete_board':
        this.tasks.deleteBoard(msg.boardId);
        return this.events.changed();
      case 'refresh_board':
        return void this.tasks.refresh(msg.boardId);
      case 'create_task': {
        const { type: _, boardId, title, ...rest } = msg;
        this.tasks.createTask(boardId, title, rest);
        return this.events.changed();
      }
      case 'update_task': {
        const { type: _, taskId, ...patch } = msg;
        this.tasks.updateTask(taskId, patch);
        return this.events.changed();
      }
      case 'delete_task':
        this.tasks.deleteTask(msg.taskId);
        return this.events.changed();
      case 'assign_task':
        this.tasks.assign(msg.taskId, msg.employeeId);
        return this.events.changed();
      case 'connect_task_provider':
        this.services.taskBoards.connect(msg.provider);
        this.events.changed();
        return;
      case 'configure_task_provider':
        this.services.taskBoards.configureCronoSpark(msg.apiKey, msg.userId);
        this.events.changed();
        return;
      case 'post':
        return this.postFromOwner(msg);
      case 'cancel_message':
        this.mail.cancel('owner', msg.messageId);
        return;
      case 'load_history': {
        const page = this.mail.history(msg.convo, msg.before, msg.limit);
        return this.events.history?.(msg.convo, page.messages, page.hasMore);
      }
      case 'answer':
        return this.answer(msg.employeeId, msg.questionId, msg.text, msg.always);
      case 'meeting_door':
        return this.setMeetingDoor(msg.state);
      case 'load_models':
        return this.loadModels(msg.provider);
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
      case 'build':
        return this.build(msg.ops);
      case 'undo':
        return this.rewrite(this.history.undo(this.building, this.ctx()));
      case 'redo':
        return this.rewrite(this.history.redo(this.building, this.ctx()));
      default: {
        const unreachable: never = msg;
        throw new OfficeError(`Unhandled message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private postFromOwner(msg: Extract<ClientMessage, { type: 'post' }>) {
    trace(msg.clientId, 'post_received');
    const target = this.mail.resolve('owner', msg.to, msg.blockId);
    if (!target.ok) throw new OfficeError(target.detail);
    if (target.id === 'owner' || target.id === 'mailroom') throw new OfficeError('Pick someone on a block to talk to.');
    const e = this.employee(target.id);
    // A boss speaking to someone who is waiting on a decision is the decision.
    if (msg.as === 'say' && e.status.kind === 'blocked_on_owner') return this.answer(e.id, e.status.question.id, msg.text);
    // A plain order is work at once. Anything else asks the model whether it is a question, which settles done with its
    // answer where work has to show files. No model, a late answer or an unclear one counts as work.
    const triage = msg.as === 'request' && !isPlainOrder(msg.text) ? this.acker.triage?.(msg.text)?.catch(() => undefined) : undefined;
    if (!triage && this.ownerPosts.waiting === 0) return this.postOwner(e.id, msg, 'work');
    // Posts keep the order the owner sent them in, even when an earlier one is still waiting for its answer.
    const before = this.ownerPosts.tail;
    this.ownerPosts.waiting++;
    this.ownerPosts.tail = (async () => {
      const asked = await triage;
      await before;
      trace(msg.clientId, 'triaged');
      try {
        if (!this.ownerPosts.closed) this.postOwner(e.id, msg, asked ?? 'work');
      } catch (err) {
        this.events.error?.(err instanceof Error ? err.message : String(err));
      } finally {
        this.ownerPosts.waiting--;
      }
    })();
  }

  private postOwner(to: EmployeeId, msg: Extract<ClientMessage, { type: 'post' }>, intent: OwnerIntent) {
    const posted = this.mail.post({
      from: 'owner',
      to,
      key: msg.clientId,
      body: msg.as === 'say' ? { kind: 'say', text: msg.text, ...(msg.urgency ? { urgency: msg.urgency } : {}) } : { kind: 'request', intent, text: msg.text },
    });
    if (!posted.ok) throw new OfficeError(posted.detail);
  }

  private commit() {
    save(this.dataFile, this.company, this.building);
    this.events.changed();
  }

  private ctx(): SpaceContext {
    return spaceCtx(this.company, seatsOf(this.company));
  }

  private setBuilding(building: Building) {
    this.building = seatEveryone(this.company, building, false);
    this.buildingRev++;
    this.events.building(building, this.buildingRev);
  }

  private build(ops: BuildOp[]) {
    const applied = applyOps(this.building, ops, this.ctx());
    if (!applied.ok) return this.events.rejected(applied.violations);
    this.history.push({ forward: applied.forward, inverse: applied.inverse, label: 'build' });
    this.setBuilding(applied.building);
    this.commit();
  }

  private rewrite(applied: ReturnType<BuildHistory['undo']>) {
    if (!applied) return;
    if (!applied.ok) return this.events.rejected(applied.violations);
    this.setBuilding(applied.building);
    this.commit();
  }

  // Office-made edits (a team's kit, a hire's new desk) are not the owner's to undo, so they skip the history.
  private apply(ops: BuildOp[]): boolean {
    const applied = applyOps(this.building, ops, this.ctx());
    if (!applied.ok) {
      console.warn(`The office could not change the building: ${applied.violations.map((v) => v.kind).join(', ')}`);
      return false;
    }
    this.setBuilding(applied.building);
    return true;
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

  private configureLinearBoard(blockId: BlockId, url: string) {
    const block = this.block(blockId);
    const parsed = new URL(url.trim());
    if (!/^(www\.)?linear\.app$/i.test(parsed.hostname)) throw new OfficeError('Linear board URL must be on linear.app');
    block.linearBoardUrl = parsed.toString();
    this.commit();
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
    this.ensureWorkspace(employee, block);
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
    const nameOf = (a: ActorId) => (a === 'owner' ? 'the owner' : a === 'mailroom' ? 'the office' : (this.company.employees.find((e) => e.id === a)?.name ?? 'someone who left'));
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
      mail: mailTools(this.mail, employee.id, nameOf, (employee.role ?? 'employee') === 'orchestrator'),
      memory: notebook,
    });
    // Adapters keep reporting for a moment after a turn ends (activity, idle). The next turn must start after that, or the
    // late idle would wipe its working status.
    const endTurn = (text: string, ok: boolean) =>
      queueMicrotask(() => {
        if (this.sessions.get(employee.id) === session) this.mail.turnEnded(employee.id, text, ok);
      });
    const host: SessionHost = {
      employee,
      block: employee.workspace ? { ...block, cwd: employee.workspace.path } : block,
      companyName: this.company.name,
      get model() {
        return employee.model;
      },
      get permissions() {
        return employee.permissions;
      },
      setStatus: live((status) => {
        this.report(employee, { status });
        if (status.kind === 'error') endTurn(status.message, false);
      }),
      setActivity: live((text) => this.report(employee, { activity: text })),
      setSessionId: live((id) => {
        employee.sessionId = id;
        this.commit();
      }),
      said: live((text) => {
        this.lastSaid.set(employee.id, text);
        this.events.said(employee.id, text);
      }),
      log: live((line) => this.events.log(employee.id, line, Date.now())),
      ask,
      mcp: { url, name: 'office' },
      memoryDigest: () => notebook.digest(block.name),
      // F2 reads the rule files here.
      rules: () => '',
      taskCompleted: live((result) => {
        employee.completedAt = Date.now();
        this.addXp(XP_PER_TASK);
        endTurn(result?.trim() || this.lastSaid.get(employee.id) || '', true);
      }),
      streamed: live((delta, done = false) => this.mail.streamed(employee.id, delta, done)),
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
    // A bubble the session left half written would hang on the owner's screen for ever.
    this.mail.closeStream(id);
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

  private hire({ provider, blockId, name: requestedName, model: requestedModel, role = 'employee', bypassLimit = false, deskId }: HireRequest): Employee {
    const { company } = this;
    const block = this.block(blockId);
    const harness = this.harnesses[provider];
    if (harness.kind !== 'ready') {
      const { label } = PROVIDERS[provider];
      throw new OfficeError(
        harness.kind === 'missing' ? `${label} is not installed on this machine.` : `${label} is installed but not connected to the office yet.`,
      );
    }
    const cap = headcountCap(company.level);
    if (!bypassLimit && company.employees.length >= cap) {
      throw new OfficeError(`Headcount cap reached (${cap} at level ${company.level}). Earn XP to grow the company.`);
    }
    const orchestrator = role === 'orchestrator';
    let desk = (deskId && this.deskToTake(deskId, blockId, orchestrator)) || freeDesk(this.building, seatsOf(company), blockId, orchestrator);
    if (!desk) {
      if (!bypassLimit && Number.isFinite(cap)) throw new OfficeError(`${block.name} has no free desk at this level`);
      const put = placeDesk(this.building, blockId, orchestrator, this.ctx());
      if (put && this.apply(put)) desk = freeDesk(this.building, seatsOf(company), blockId, orchestrator);
      if (!desk) throw new OfficeError(`${block.name} has no room for another desk`);
    }

    const employee: Employee = {
      id: newId<EmployeeId>(),
      name: requestedName?.trim() || this.pickName(),
      provider,
      role,
      blockId,
      seat: desk.id,
      status: { kind: 'idle' },
      activity: 'Just started, settling in at my desk',
      model: requestedModel ?? company.settings.defaultModels[provider] ?? HARNESSES[provider].defaultModel(),
      permissions: { mode: company.settings.defaultPermissions, alwaysAllow: [] },
      subagents: [],
      hiredAt: Date.now(),
    };
    company.employees.push(employee);
    this.startSession(employee);
    this.sessions.get(employee.id)?.warm?.();
    if (provider === 'claude-code') this.acker.warm();
    this.commit();
    return employee;
  }

  // The desk the owner asked for, when it is a free one of the right kind in the block.
  private deskToTake(deskId: ItemId, blockId: BlockId, orchestrator: boolean) {
    const probe = 'desk-probe' as SpaceEmployeeId;
    const item = deskOf(this.building, new Map([[probe, deskId]]), probe);
    const taken = seatsOf(this.company);
    const free = ![...taken.values()].includes(deskId);
    return item && free && item.blockId === blockId && ITEM_DEFS[item.def]?.kind === (orchestrator ? 'po_desk' : 'bench_desk') ? item : null;
  }

  // The one place a PO's hire becomes an employee, so the seat model can change it in one spot.
  private hireFor(from: EmployeeId, spec: HireSpec): Hired {
    const po = this.employee(from);
    try {
      const hired = this.hire({ provider: po.provider, blockId: po.blockId, name: spec.name, role: 'employee' });
      return { ok: true, id: hired.id, name: hired.name };
    } catch (err) {
      if (err instanceof OfficeError) return { ok: false, reason: err.message };
      throw err;
    }
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
    this.tasks.rememberPerson(e.id, e.name);
    this.mail.employeeFired(e.id);
    this.stopSession(e.id);
    const block = this.company.blocks.find((b) => b.id === e.blockId);
    if (e.workspace && block) removeWorkspace(block.cwd, e.workspace, e.name);
    this.company.employees = this.company.employees.filter((x) => x.id !== e.id);
    // Their own notes go to alumni/. The block's notes stay for whoever works there next.
    this.services.memory.archive(e.id).catch((err) => console.error(`Could not archive ${e.name}'s notes:`, err));
  }

  private removeBlock(blockId: BlockId) {
    const block = this.block(blockId);
    for (const e of this.company.employees.filter((x) => x.blockId === blockId)) this.dismiss(e);
    this.company.blocks = this.company.blocks.filter((b) => b !== block);
    this.dropItems(blockId);
    this.tasks.dropBlock(blockId);
    this.commit();
  }

  // The team's furniture goes with it. The floor and walls stay, so the owner keeps the space.
  private dropItems(blockId: BlockId) {
    const ops: BuildOp[] = this.building.stories.flatMap((s, story) => {
      const del = s.items.filter((i) => i.blockId === blockId).map((i) => i.id);
      return del.length ? [{ t: 'items' as const, story, put: [], del }] : [];
    });
    if (ops.length) this.apply(ops);
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
    const block: ProjectBlock = { id: newId<BlockId>(), name: name?.trim() || basename(cwd), cwd, color, slot, ...(repo && { githubRepo: repo }) };
    blocks.push(block);
    this.tasks.addBlock();
    this.apply(teamKit(this.building, block.id, slot));
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
        for (const e of members) {
          if (e.workspace) removeWorkspace(block.cwd, e.workspace, e.name);
          delete e.workspace;
        }
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

  // The folder is checked when the block is made, but it can be deleted later. A harness started there fails with its
  // own misleading error: Claude's blames its binary.
  private assertFolderExists(e: Employee) {
    const block = this.block(e.blockId);
    if (!existsSync(block.cwd)) throw new OfficeError(`${block.name}'s folder ${block.cwd} no longer exists. Restore it, or make a new block on a folder that does.`);
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
    this.sessionOf(e).warm?.();
    // What it was serving is over. Anything queued behind goes to the new session.
    this.mail.turnEnded(id, 'The session was restarted before this finished.', false);
    this.commit();
  }

  private reset() {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
    const fresh = seed();
    this.company = fresh.company;
    this.history = new BuildHistory();
    this.setBuilding(fresh.building);
    rmSync(this.ledgerFile, { force: true });
    this.tasks.reset();
    this.mail = this.openMail([]);
    this.meetingDoor = 'open';
    this.commit();
    this.services.memory.wipe().catch((err) => console.error('Could not wipe memory:', err));
  }
}
