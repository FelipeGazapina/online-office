import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESKS_PER_BLOCK,
  MAX_LEVEL,
  XP_FOR_LEVEL,
  headcountCap,
  type BlockId,
  type ClientMessage,
  type Company,
  type Employee,
  type EmployeeId,
  type ProjectBlock,
  type Provider,
  type QuestionId,
} from '../shared/protocol.ts';
import { ADAPTERS } from './adapters/index.ts';
import type { EmployeeSession, SessionHost } from './adapters/types.ts';

const XP_PER_TASK = 10;
const XP_PER_QUICK_ANSWER = 3;
const QUICK_ANSWER_MS = 120_000;

const DATA_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.office-data', 'company.json');

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
};

export const levelForXp = (xp: number): number => {
  let level = 1;
  for (let l = 1; l <= MAX_LEVEL; l++) if (xp >= XP_FOR_LEVEL[l]!) level = l;
  return level;
};

const newId = <T extends string>() => randomUUID() as T;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
const defaultCwd = (name: string) => join(homedir(), 'online-office', 'workspaces', slugify(name));
const ensureDir = (dir: string) => void mkdirSync(dir, { recursive: true });

function makeBlock(name: string, slot: number, color: string, cwd = defaultCwd(name)): ProjectBlock {
  ensureDir(cwd);
  return { id: newId<BlockId>(), name, cwd, color, slot };
}

function seed(): Company {
  const requested = Number.parseInt(process.env.OFFICE_START_LEVEL ?? '1', 10);
  const level = Math.min(Math.max(Number.isNaN(requested) ? 1 : requested, 1), MAX_LEVEL);
  return {
    name: 'Gazapina Labs',
    level,
    xp: XP_FOR_LEVEL[level],
    blocks: [
      makeBlock('Client Apps', 0, '#5b8def'),
      makeBlock('Podium', 1, '#f2a541'),
      makeBlock('Syntax', 2, '#4fb286'),
    ],
    employees: [],
  };
}

function load(): Company | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return undefined;
  }
  // Only this bridge writes the file, so a shape check is enough; anything odd falls back to a fresh seed.
  const c = raw as Partial<Company> | null;
  if (!c || typeof c.name !== 'string' || typeof c.level !== 'number' || typeof c.xp !== 'number') return undefined;
  if (!Array.isArray(c.blocks) || !Array.isArray(c.employees)) return undefined;
  return c as Company;
}

function save(company: Company) {
  ensureDir(dirname(DATA_FILE));
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(company, null, 2));
  renameSync(tmp, DATA_FILE);
}

export class Office {
  private company: Company;
  private sessions = new Map<EmployeeId, EmployeeSession>();

  constructor(private events: OfficeEvents) {
    this.company = load() ?? seed();
    for (const b of this.company.blocks) ensureDir(b.cwd);
    for (const e of this.company.employees) {
      if (e.status.kind === 'working' || e.status.kind === 'blocked_on_owner') {
        e.status = { kind: 'idle' };
        e.activity = 'Back from a break (bridge restarted)';
      }
      this.startSession(e);
    }
    save(this.company);
  }

  snapshot(): Company {
    return this.company;
  }

  shutdown() {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }

  handle(msg: ClientMessage): void {
    switch (msg.type) {
      case 'hire':
        return this.hire(msg.provider, msg.blockId, msg.name);
      case 'fire':
        return this.fire(msg.employeeId);
      case 'create_block':
        return this.createBlock(msg.name, msg.cwd);
      case 'update_block':
        return this.updateBlock(msg.blockId, msg.name, msg.cwd);
      case 'assign':
        return this.assign(msg.employeeId, msg.task);
      case 'answer':
        return this.answer(msg.employeeId, msg.questionId, msg.text);
      case 'interject': {
        const e = this.employee(msg.employeeId);
        // A boss speaking to someone who is waiting on a decision is the decision.
        if (e.status.kind === 'blocked_on_owner') return this.answer(e.id, e.status.question.id, msg.text);
        return this.sessionOf(e).interject(msg.text, msg.style);
      }
      case 'reset_company':
        return this.reset();
      default: {
        const unreachable: never = msg;
        throw new OfficeError(`Unhandled message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private commit() {
    save(this.company);
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
    let session: EmployeeSession | undefined;
    // A stopped session (fired, reset, block moved) can still have a message in flight.
    // Dropping its callbacks here keeps it from touching a newer company.
    const live =
      <A extends unknown[]>(f: (...a: A) => void) =>
      (...a: A) => {
        if (this.sessions.get(employee.id) === session) f(...a);
      };
    const host: SessionHost = {
      employee,
      block,
      companyName: this.company.name,
      setStatus: live((status) => {
        employee.status = status;
        this.commit();
      }),
      setActivity: live((text) => {
        employee.activity = text;
        this.commit();
      }),
      setSessionId: live((id) => {
        employee.sessionId = id;
        this.commit();
      }),
      said: live((text) => this.events.said(employee.id, text)),
      log: live((line) => this.events.log(employee.id, line, Date.now())),
      drawWhiteboard: live((title, mermaid) => {
        block.whiteboard = { title, mermaid, by: employee.id, at: Date.now() };
        this.commit();
      }),
      taskCompleted: live(() => this.addXp(XP_PER_TASK)),
    };
    session = ADAPTERS[employee.provider](host);
    this.sessions.set(employee.id, session);
  }

  private stopSession(id: EmployeeId) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    s?.stop();
  }

  private hire(provider: Provider, blockId: BlockId, requestedName?: string) {
    const { company } = this;
    const block = this.block(blockId);
    const cap = headcountCap(company.level);
    if (company.employees.length >= cap) {
      throw new OfficeError(`Headcount cap reached (${cap} at level ${company.level}). Earn XP to grow the company.`);
    }
    const taken = new Set(company.employees.filter((e) => e.blockId === blockId).map((e) => e.desk));
    let desk = 0;
    while (taken.has(desk)) desk++;
    if (desk >= DESKS_PER_BLOCK) throw new OfficeError(`${block.name} has no free desk`);

    const employee: Employee = {
      id: newId<EmployeeId>(),
      name: requestedName?.trim() || this.pickName(),
      provider,
      blockId,
      desk,
      status: { kind: 'idle' },
      activity: 'Just started, settling in at my desk',
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
    const e = this.employee(id);
    this.stopSession(e.id);
    this.company.employees = this.company.employees.filter((x) => x.id !== e.id);
    this.commit();
  }

  private createBlock(name: string, cwd?: string) {
    const { blocks } = this.company;
    const slots = new Set(blocks.map((b) => b.slot));
    let slot = 0;
    while (slots.has(slot)) slot++;
    const usedColors = new Set(blocks.map((b) => b.color));
    const color = BLOCK_COLORS.find((c) => !usedColors.has(c)) ?? BLOCK_COLORS[slot % BLOCK_COLORS.length]!;
    blocks.push(makeBlock(name.trim(), slot, color, cwd ? resolve(expandHome(cwd)) : undefined));
    this.commit();
  }

  private updateBlock(blockId: BlockId, name?: string, cwd?: string) {
    const block = this.block(blockId);
    if (name) block.name = name.trim();
    if (cwd) {
      const next = resolve(expandHome(cwd));
      if (next !== block.cwd) {
        const members = this.company.employees.filter((e) => e.blockId === blockId);
        const busy = members.find((e) => e.status.kind === 'working' || e.status.kind === 'blocked_on_owner');
        if (busy) throw new OfficeError(`${busy.name} is busy. Move ${block.name} when everyone is idle.`);
        ensureDir(next);
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
    this.sessionOf(e).assign(task.trim());
  }

  private answer(id: EmployeeId, questionId: QuestionId, text: string) {
    const e = this.employee(id);
    if (e.status.kind !== 'blocked_on_owner' || e.status.question.id !== questionId) {
      throw new OfficeError(`${e.name} has no open question ${questionId}`);
    }
    const { askedAt } = e.status.question;
    this.sessionOf(e).answer(questionId, text);
    if (Date.now() - askedAt <= QUICK_ANSWER_MS) this.addXp(XP_PER_QUICK_ANSWER);
  }

  private reset() {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
    this.company = seed();
    this.commit();
  }
}
