// A fake bridge, enabled with ?demo=1. It speaks the same protocol so the world can be judged
// without the real bridge running: employees ask questions on a timer, hires and fires work.
import {
  DESKS_PER_BLOCK,
  headcountCap,
  XP_FOR_LEVEL,
  type BlockId,
  type ClientMessage,
  type Company,
  type Employee,
  type EmployeeId,
  type QuestionId,
} from '../../shared/protocol.ts';
import { addLog, applyServerMessage } from './bridge.ts';
import { set, setSender } from './store.ts';

const id = <T extends string>(s: string) => s as T;
const DIAGRAM = `flowchart LR
  UI[Storefront UI] --> API[Orders API]
  API --> DB[(Postgres)]
  API --> Q{{Payment queue}}
  Q --> W[Worker]`;

const QUESTIONS: { text: string; options?: string[] }[] = [
  { text: 'Should I migrate the orders table now, or wait for the freeze to end?', options: ['Migrate now', 'Wait'] },
  { text: 'The tests pass but the linter fails on 14 files. Fix them all?', options: ['Fix all', 'Only mine'] },
  { text: 'Which name do you want for the new service?' },
  { text: 'I found a flaky test. Skip it, or dig into it?', options: ['Skip', 'Dig in'] },
];

const ACTIVITIES = ['Reading src/orders.ts', 'Running the test suite', 'Editing checkout.tsx', 'Searching for usages of Cart', 'Drafting a migration'];

export function startDemo() {
  const now = Date.now();
  let seq = 100;
  let company: Company = {
    name: 'Gazapina & Co',
    level: 3,
    xp: 41,
    blocks: [
      { id: id<BlockId>('b1'), name: 'Storefront', cwd: '~/code/storefront', color: '#4f8cff', slot: 0, whiteboard: { title: 'Order flow', mermaid: DIAGRAM, by: id<EmployeeId>('e1'), at: now } },
      { id: id<BlockId>('b2'), name: 'Payments', cwd: '~/code/payments', color: '#e0a43a', slot: 1 },
    ],
    employees: [
      emp('e1', 'Mira', 'claude-code', 'b1', 0),
      emp('e2', 'Theo', 'codex', 'b1', 1),
      emp('e3', 'Sana', 'cursor', 'b2', 0),
    ],
  };
  company.employees[1].status = { kind: 'idle' };
  company.employees[1].activity = 'Waiting for work';

  function emp(eid: string, name: string, provider: Employee['provider'], block: string, desk: number): Employee {
    return {
      id: id<EmployeeId>(eid),
      name,
      provider,
      blockId: id<BlockId>(block),
      desk,
      status: { kind: 'working', task: 'Refactor checkout flow', startedAt: Date.now() },
      activity: ACTIVITIES[seq++ % ACTIVITIES.length],
      hiredAt: Date.now(),
    };
  }

  const push = () => applyServerMessage({ type: 'snapshot', company: structuredClone(company) });
  const find = (eid: string) => company.employees.find((e) => e.id === eid);
  const say = (eid: EmployeeId, text: string) => applyServerMessage({ type: 'said', employeeId: eid, text });
  const log = (eid: EmployeeId, line: string) => addLog(eid, line, Date.now());

  function ask(e: Employee) {
    const q = QUESTIONS[seq++ % QUESTIONS.length];
    e.status = { kind: 'blocked_on_owner', task: e.status.kind === 'working' ? e.status.task : 'Refactor checkout flow', question: { id: id<QuestionId>(`q${seq}`), ...q, askedAt: Date.now() } };
    e.activity = 'Needs a decision';
    log(e.id, `asked: ${q.text}`);
    push();
  }

  function handle(m: ClientMessage): boolean {
    switch (m.type) {
      case 'hire': {
        if (company.employees.length >= headcountCap(company.level)) return true;
        const taken = new Set(company.employees.filter((e) => e.blockId === m.blockId).map((e) => e.desk));
        const desk = [...Array(DESKS_PER_BLOCK).keys()].find((d) => !taken.has(d));
        if (desk === undefined) return true;
        company.employees.push(emp(`e${++seq}`, m.name || ['Ines', 'Jonas', 'Lea', 'Omar', 'Pia'][seq % 5], m.provider, m.blockId, desk));
        break;
      }
      case 'fire':
        company.employees = company.employees.filter((e) => e.id !== m.employeeId);
        break;
      case 'create_block': {
        const slot = company.blocks.reduce((mx, b) => Math.max(mx, b.slot), -1) + 1;
        company.blocks.push({ id: id<BlockId>(`b${++seq}`), name: m.name, cwd: m.cwd ?? '~', color: ['#7ab87a', '#c46bd0', '#e0645a', '#3fb5c4'][slot % 4], slot });
        break;
      }
      case 'update_block': {
        const b = company.blocks.find((x) => x.id === m.blockId);
        if (b) Object.assign(b, { ...(m.name && { name: m.name }), ...(m.cwd && { cwd: m.cwd }) });
        break;
      }
      case 'assign': {
        const e = find(m.employeeId);
        if (!e) return true;
        e.status = { kind: 'working', task: m.task, startedAt: Date.now() };
        e.activity = 'Reading the codebase';
        log(e.id, `assigned: ${m.task}`);
        say(e.id, 'On it.');
        break;
      }
      case 'answer': {
        const e = find(m.employeeId);
        if (!e || e.status.kind !== 'blocked_on_owner') return true;
        e.status = { kind: 'working', task: e.status.task, startedAt: Date.now() };
        e.activity = 'Applying your answer';
        company.xp += 6;
        if (company.level < 5 && company.xp >= XP_FOR_LEVEL[company.level + 1]) company.level++;
        log(e.id, `owner answered: ${m.text}`);
        say(e.id, 'Got it, thanks.');
        break;
      }
      case 'interject': {
        const e = find(m.employeeId);
        if (!e) return true;
        log(e.id, `owner interjected (${m.style}): ${m.text}`);
        say(e.id, m.style === 'now' ? 'Stopping. Go ahead.' : 'Noted, I will pick that up next.');
        return true;
      }
      case 'reset_company':
        return true;
    }
    push();
    return true;
  }

  setSender(handle);
  set({ conn: 'open', demo: true });
  push();
  for (const e of company.employees) log(e.id, `hired: ${e.name}`);

  // Work happens: activities change, and every so often somebody needs the owner.
  setInterval(() => {
    for (const e of company.employees) if (e.status.kind === 'working') e.activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
    push();
  }, 7000);
  const scheduleAsk = (delay: number) =>
    setTimeout(() => {
      const auto = (window as unknown as { __demo: { auto: boolean } }).__demo.auto;
      const workers = company.employees.filter((e) => e.status.kind === 'working');
      if (auto && workers.length) ask(workers[Math.floor(Math.random() * workers.length)]);
      scheduleAsk(14000 + Math.random() * 12000);
    }, delay);
  scheduleAsk(5000);
  // Query hooks for verification: ?demo=1 exposes __demo.ask(name) to force a question.
  (window as unknown as { __demo: unknown }).__demo = { auto: true, ask: (name: string) => { const e = company.employees.find((x) => x.name === name); if (e) ask(e); } };
}
