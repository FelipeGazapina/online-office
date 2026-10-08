// The office the RAM harness measures: a scratch copy of the owner's, grown to 3 floors and made ready for 15 employees.
// The owner's data folder is only ever read, and from it only company.json, tasks.json and company.mail.jsonl (never
// task-board-credentials.json, never worktrees/). Every block points at its own scratch git repo seeded with real code (a copy of this
// app's own shared and main sources), has no remote and no GitHub repo, and every employee starts a fresh session on haiku.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAIKU } from './lib.mjs';
import { applyOps, encodeBuilding, parseBuilding, rectWalls } from '../src/shared/space/index.ts';
import { benchItem } from '../src/shared/space/kit.ts';
import { emptyMail, fold } from '../src/main/office/mail.ts';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OWNER_DIR = join(homedir(), 'Library', 'Application Support', 'Online Office');
const FILES = ['company.json', 'tasks.json', 'company.mail.jsonl'];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

// A repo with real code to work on and no remote, so nothing an agent does leaves the machine.
export function seedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const sub of ['src/shared', 'src/main/office']) cpSync(join(APP, sub), join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', private: true, type: 'module' }, null, 2));
  writeFileSync(join(dir, 'README.md'), '# scratch\n\nA copy of some sources to read, test and document. There is no network and nothing to install.\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
}

// The ledger up to its last quiet moment: no message waiting for anyone and no turn open. A copy taken while the owner works could end
// mid-request, and the app would hand that request to a person on start.
function quietLedger(text) {
  const lines = text.split('\n').filter(Boolean);
  const state = emptyMail();
  let keep = 0;
  lines.forEach((line, i) => {
    try {
      fold(state, JSON.parse(line));
    } catch {
      return;
    }
    if ([...state.queue.values()].every((q) => q.length === 0) && state.active.size === 0) keep = i + 1;
  });
  return { text: lines.slice(0, keep).map((l) => `${l}\n`).join(''), kept: keep, total: lines.length };
}

// Stories 1 and 2: floor over the whole lot, windows round it, stairs from 1 to 2, a bench desk of each block for the new hires, and
// the same decor e2e-perf puts on a story. Each piece goes in alone so one that does not fit is skipped, not fatal.
function grow(building, company) {
  const lot = building.lot;
  let b = building;
  const ctx = {
    blocks: new Set(company.blocks.map((x) => x.id)),
    employees: new Map(company.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
    seats: new Map(company.employees.map((e) => [e.id, e.seat])),
  };
  const must = (label, ops) => {
    const r = applyOps(b, ops, ctx);
    if (!r.ok) throw new Error(`cannot build ${label}: ${JSON.stringify(r.violations).slice(0, 300)}`);
    b = r.building;
  };
  const skipped = [];
  const maybe = (label, ops) => {
    const r = applyOps(b, ops, ctx);
    if (r.ok) b = r.building;
    else skipped.push(label);
    return r.ok;
  };
  must('stories', [{ t: 'stories', count: 3 }]);
  for (const story of [1, 2]) {
    const cells = Array.from({ length: lot.w * lot.h }, (_, i) => ({ x: lot.x0 + (i % lot.w), z: lot.z0 + Math.floor(i / lot.w), half: 0, paint: story + 1 }));
    must(`floor ${story}`, [{ t: 'floor', story, cells }]);
    const walls = rectWalls({ x: lot.x0, z: lot.z0, w: lot.w, h: lot.h }, 2).map((w, i) => (i % 6 >= 1 && i % 6 <= 4 ? { ...w, open: 'window' } : w));
    must(`walls ${story}`, [{ t: 'walls', story, put: walls, del: [] }]);
  }
  const stairs = [[30, 4], [20, 4], [-20, 4], [30, -20], [0, 20]].find(([x, z]) => maybe(`stairs ${x},${z}`, [{ t: 'items', story: 1, put: [{ id: 'stairs:up12', def: 'stairs', x, z, rot: 0 }], del: [] }]));
  if (!stairs) throw new Error('no place for the stairs up to story 2');
  // One bench desk per block on each upper story for a new hire, and a second so the story looks used.
  const desks = [];
  for (const story of [1, 2]) {
    for (const block of company.blocks) {
      for (const k of [0, 1]) {
        const item = { ...benchItem(block.id, block.slot, k), id: `${block.id}:bench_desk:${story}${k}` };
        if (maybe(`desk ${story}/${block.name}/${k}`, [{ t: 'items', story, put: [item], del: [] }]) && k === 0) desks.push({ blockId: block.id, deskId: item.id, story });
      }
    }
    for (const [def, x, z] of [['plant', -30, -30], ['sofa', 20, 10], ['bookshelf', -34, -38], ['meeting_table', 20, -20]]) maybe(`${def} ${story}`, [{ t: 'items', story, put: [{ id: `${def}:${story}0`, def, x, z, rot: 0 }], del: [] }]);
  }
  return { building: b, desks, skipped };
}

// Copies and rewrites the owner's office into `dir`. Returns what the scenario needs to know.
export function prepareOffice({ dir, source = OWNER_DIR, hires = 6 }) {
  // A second run into the same folder starts clean; only the two folders this function makes are touched.
  for (const sub of ['data', 'repos']) rmSync(join(dir, sub), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const read = (name) => {
    if (!existsSync(join(source, name))) throw new Error(`${join(source, name)} does not exist`);
    return readFileSync(join(source, name), 'utf8');
  };
  const [companyText, tasksText, ledgerText] = FILES.map(read);
  const company = JSON.parse(companyText);

  const repos = {};
  for (const block of company.blocks) {
    const repo = join(dir, 'repos', block.name.replace(/[^\w.-]+/g, '-'));
    seedRepo(repo);
    repos[block.id] = repo;
    block.cwd = repo;
    delete block.githubRepo;
    delete block.linearBoardUrl;
  }
  for (const e of company.employees) {
    delete e.workspace;
    delete e.sessionId;
    delete e.completedAt;
    e.model = HAIKU;
    e.status = { kind: 'idle' };
    e.permissions = { mode: 'yolo', alwaysAllow: e.permissions?.alwaysAllow ?? [] };
  }
  const grown = grow(parseBuilding(company.building), company);
  company.building = encodeBuilding(grown.building);

  const ledger = quietLedger(ledgerText);
  writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));
  writeFileSync(join(dataDir, 'tasks.json'), tasksText);
  writeFileSync(join(dataDir, 'company.mail.jsonl'), ledger.text);

  // The new hires: two per block would be six, one on story 1 and one on story 2 each.
  const plan = grown.desks.slice(0, hires);
  return {
    dataDir,
    repos,
    plan,
    skipped: grown.skipped,
    owner: { employees: company.employees.length, blocks: company.blocks.length, stories: grown.building.stories.length },
    ledger: { kept: ledger.kept, total: ledger.total },
    copied: FILES,
  };
}

// What an employee is asked to do. Each is real work on the seeded code, takes a few minutes of tool calls, and needs no network,
// no install and nobody else. `me` keeps the files of two employees apart; `n` picks the piece of work.
const SOURCES = [
  'src/shared/terminal.ts', 'src/shared/tasks.ts', 'src/shared/activity.ts', 'src/shared/protocol.ts', 'src/main/office/mail.ts',
  'src/main/office/tasks.ts', 'src/main/office/workspace.ts', 'src/shared/space/validate.ts', 'src/shared/space/nav.ts', 'src/main/office/inbox.ts',
];
const ALONE = 'Work alone with your own tools: do not delegate, do not ask anyone, do not hire anybody. There is no network and nothing to install. Commit what you write on your branch.';
const WORK = [
  (f, me, n) => ({ title: `Explain ${f}`, notes: `Read ${f}. Write notes/${me}-${n}.md with one section per exported function or class: its name, what it is for in one sentence, and what it takes and returns. At least 30 lines. Then run wc -l on it. ${ALONE}` }),
  (f, me, n) => ({ title: `Tests for ${f}`, notes: `Read ${f}. Write test/${me}-${n}.test.ts with node:test covering at least 3 exported pure functions, then run node --test test/${me}-${n}.test.ts and fix the tests until they pass. If a function needs an import that fails, choose another one. ${ALONE}` }),
  (f, me, n) => ({ title: `Review ${f}`, notes: `Read ${f} closely. List 5 risky spots with line numbers in review/${me}-${n}.md, each with the input that would break it. Then fix the smallest one in the source and show git diff --stat. ${ALONE}` }),
  (f, me, n) => ({ title: `Size report for ${f}`, notes: `Using grep, wc and awk, find the 10 longest functions in ${f} and the files that import it. Write scripts/${me}-${n}.mjs that prints them as a table, and run it. ${ALONE}` }),
  (f, me, n) => ({ title: `Document ${f}`, notes: `Add a short doc comment to the 5 most important exported functions in ${f} that lack one. Do not change behaviour. Show git diff when done. ${ALONE}` }),
];
export const workFor = (me, index, round) => {
  const file = SOURCES[(index + round * 3) % SOURCES.length];
  return WORK[(index + round) % WORK.length](file, me.toLowerCase().replace(/\W+/g, ''), round);
};
