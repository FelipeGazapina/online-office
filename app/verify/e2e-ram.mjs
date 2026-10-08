// The RAM bar, measured: a scratch copy of the owner's office grown to 3 floors and 15 employees, all 15 working for N minutes with live
// terminals on their monitors, in a visible 1440x900 window at the display's own pixel ratio. Every 10 s the memory of the app's whole
// process tree is read (phys_footprint, the Activity Monitor Memory column) and sorted into classes; around 80% of the run the frames
// are timed for 10 s; around 90% the memory is broken down by owner; at the end four shots and two heap snapshots are taken.
//
// Run:  pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-ram.mjs
//   OFFICE_RAM_AGENTS=fake   same office, no agents: the synthetic terminal feed of e2e-perf on all 15 monitors (iterate on this one)
//   OFFICE_RAM_MINUTES=10    length of the measured window (default 10); the slope covers its second half
//   OFFICE_RAM_OUT=<dir>     where the scratch office, result JSON, heap summaries and shots go (default /tmp/office-ram/<stamp>-<mode>)
//   OFFICE_RAM_SHOTS=<dir>   where the four shots go (default <out>/shots)
//   OFFICE_RAM_UNIT, OFFICE_RAM_ROUND   the first two columns of the ram.tsv line
//   OFFICE_RAM_KEEP_HEAP=1   keep the .heapsnapshot files (hundreds of MB); the summaries are always kept
//   OFFICE_RAM_SCALE=1       force the device pixel ratio (default: the display's own)
// The run is invalid, and says so, when another Online Office app was running at any sample (the owner's included) or fewer than 15
// people were working for most of the window. The result JSON is written either way.
// The owner's data folder is only read (ram-office.mjs). Linear is a fake MCP server, gh is a fake on PATH, the repos have no remote.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { TerminalBuffer } from '../src/shared/terminal.ts';
import { installFakeGh } from './fake-gh.ts';
import { linearWorld, startFakeLinear, TOKEN } from './fake-linear.ts';
import { startSampler, summarize } from './footprint-sampler.mjs';
import { summarize as summarizeHeap } from './heap-summary.mjs';
import { connect, targets } from './inspector.mjs';
import { HAIKU, sceneReady } from './lib.mjs';
import { prepareOffice, workFor } from './ram-office.mjs';

const MINUTES = Number(process.env.OFFICE_RAM_MINUTES ?? 10);
const FAKE = process.env.OFFICE_RAM_AGENTS === 'fake';
const CDP_PORT = Number(process.env.OFFICE_CDP_PORT ?? 9333);
const INSPECT_PORT = CDP_PORT + 100;
const EMPLOYEES = 15;
const SAMPLE_MS = 10_000;
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const OUT = process.env.OFFICE_RAM_OUT ?? `/tmp/office-ram/${stamp}-${FAKE ? 'fake' : 'real'}`;
const SHOTS = process.env.OFFICE_RAM_SHOTS ?? join(OUT, 'shots');
const state = '__office.store.getState()';
const r1 = (n) => +n.toFixed(1);
const r2 = (n) => +n.toFixed(2);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const exclusive = true;
export const viewport = { width: 1440, height: 900, scale: process.env.OFFICE_RAM_SCALE ? Number(process.env.OFFICE_RAM_SCALE) : 'native' };
export const env = {};

let office;
let linear;

export async function prepare() {
  mkdirSync(OUT, { recursive: true });
  office = prepareOffice({ dir: OUT, hires: EMPLOYEES - 9 });
  linear = await startFakeLinear(linearWorld(50, 8));
  const gh = installFakeGh(OUT);
  Object.assign(env, {
    OFFICE_DATA_DIR: office.dataDir,
    OFFICE_TEST_RUN: '',
    OFFICE_CLAUDE_MODEL: HAIKU,
    OFFICE_INSPECT_PORT: String(INSPECT_PORT),
    OFFICE_TASK_BOARD_FIXTURE: '',
    LINEAR_MCP_URL: linear.url,
    LINEAR_MCP_TOKEN: TOKEN,
    PATH: `${gh.bin}${delimiter}${process.env.PATH}`,
    ...(FAKE ? { OFFICE_NO_AGENTS: '1', OFFICE_ACK: '0' } : {}),
  });
  console.log(`[ram] scratch office in ${OUT}; ${MINUTES} min, ${FAKE ? 'fake terminal feed' : 'real haiku agents'}; ledger kept ${office.ledger.kept} of ${office.ledger.total} entries`);
}

process.on('exit', () => {
  void linear?.close();
});

// A terminal feed like e2e-perf's: what main would push for an employee who keeps reading, a tenth of a second apart, each push being
// what changed since the one before. Generated here a chunk at a time so ten minutes of it never sits in one message.
function terminalFeed(ids) {
  const buffers = ids.map(() => new TerminalBuffer('/work/repo', 'Claude Code', HAIKU));
  let step = 0;
  const first = ids.map((id, e) => ({ ...buffers[e].take(), employeeId: id, type: 'terminal' }));
  return {
    first,
    chunk(count) {
      const out = [];
      for (let k = 0; k < count; k++, step++) {
        out.push(
          buffers.map((buffer, e) => {
            if (step % 25 === 0) buffer.apply({ k: 'tool', id: `t${step}`, name: 'Read', input: { file_path: `/work/repo/src/file${step}.ts` } });
            else if (step % 25 === 3) buffer.apply({ k: 'result', id: `t${step - 3}`, ok: true, text: 'x', data: { file: { numLines: 40 + step } } });
            else buffer.apply({ k: 'text', id: `m${Math.floor(step / 25)}`, text: `Reading the module and checking how the retry logic handles a failed request, step ${step}. `.repeat(1 + (step % 25)) });
            return { ...buffer.take(), employeeId: ids[e], type: 'terminal' };
          }),
        );
      }
      return out;
    },
  };
}

export const diagnose = async (s) => {
  console.log('employees at failure:', await s.eval(`JSON.stringify(${state}.company.employees.map((e) => [e.name, e.status.kind]))`).catch(() => '?'));
  await s.shot('ram-failure').catch(() => {});
};

export default async function (s) {
  const t00 = Date.now();
  const log = (msg) => console.log(`[ram +${((Date.now() - t00) / 1000).toFixed(0)}s] ${msg}`);
  await s.waitFor(`!!${state}.company && ${state}.company.employees.length === ${office.owner.employees} && !!${state}.building`, 60_000);
  await s.cdp('Page.bringToFront');
  log(`the owner's office is up: ${office.owner.blocks} blocks, ${office.owner.employees} employees, ${office.owner.stories} stories`);

  // ---- 15 people. Six hires go through the app's own hire path onto the upper-story desks (real mode); the fake mode adds them to the store.
  const injectFake = () =>
    s.eval(`(() => {
      const st = ${state};
      const now = Date.now();
      const real = st.company.employees.filter((e) => !e.id.startsWith('fake-emp-'));
      const extra = ${JSON.stringify(office.plan)}.slice(0, ${EMPLOYEES - office.owner.employees}).map((p, i) => ({ id: 'fake-emp-' + i, name: 'Fake ' + i, provider: 'claude-code', blockId: p.blockId, seat: p.deskId, status: {}, activity: '', model: 'fake', permissions: { mode: 'yolo', alwaysAllow: [] }, subagents: [], hiredAt: now }));
      const employees = [...real, ...extra].map((e) => ({ ...e, status: { kind: 'working', task: 'fake task', startedAt: now }, activity: 'typing' }));
      __office.set({ company: { ...st.company, employees } });
      return employees.length;
    })()`);
  if (FAKE) {
    await injectFake();
  } else {
    for (const p of office.plan) {
      const before = await s.eval(`${state}.company.employees.length`);
      await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(p.blockId)}, model: ${JSON.stringify(HAIKU)}, deskId: ${JSON.stringify(p.deskId)} })`);
      await s.waitFor(`${state}.company.employees.length === ${before + 1}`, 30_000);
    }
    for (const e of JSON.parse(await s.eval(`JSON.stringify(${state}.company.employees.filter((e) => e.permissions.mode !== 'yolo').map((e) => e.id))`))) {
      await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(e)}, mode: 'yolo' })`);
    }
  }
  const people = JSON.parse(await s.eval(`JSON.stringify(${state}.company.employees.map((e) => ({ id: e.id, name: e.name, role: e.role ?? 'employee', blockId: e.blockId })))`));
  if (people.length !== EMPLOYEES) throw new Error(`expected ${EMPLOYEES} employees, found ${people.length}`);
  log(`${people.length} employees: ${people.map((p) => p.name).join(', ')}`);

  // Let the avatars walk to their desks and the camera settle on an overview of the three stories.
  await sceneReady(s);
  await s.eval('__office.ownerTo(2, 0, -12)');
  await s.sleep(4000);

  // ---- Main's inspector and a second session on the page.
  const mainTarget = (await targets(INSPECT_PORT))[0];
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  const pageTarget = (await targets(CDP_PORT)).find((t) => t.type === 'page' && t.url.startsWith('file:'));
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.call('Runtime.enable');

  // ---- The measured window starts when the first task goes out.
  const live = { working: 0, idle: 0, blocked: 0, error: 0, employees: 0, reinjected: 0 };
  const preexisting = new Set(JSON.parse(await s.eval(`JSON.stringify(${state}.tasks.map((t) => t.id))`)));
  // The tasks this run handed out that still wait for their person, by person: the one running is in doing, the next one waits in todo.
  const waiting = new Map();
  const readPeople = async () => {
    const mine = JSON.parse(await s.eval(`JSON.stringify(${state}.tasks.map((t) => [t.id, t.stage, t.assignees]))`)).filter(([id]) => !preexisting.has(id));
    waiting.clear();
    for (const [, stage, who] of mine) if (stage === 'todo') for (const w of who) waiting.set(w, (waiting.get(w) ?? 0) + 1);
    const now = JSON.parse(await s.eval(`JSON.stringify(${state}.company.employees.map((e) => ({ id: e.id, kind: e.status.kind, q: e.status.question?.id ?? null })))`));
    live.employees = now.length;
    live.working = now.filter((e) => e.kind === 'working').length;
    live.idle = now.filter((e) => e.kind === 'idle').length;
    live.blocked = now.filter((e) => e.kind === 'blocked_on_owner').length;
    live.error = now.filter((e) => e.kind === 'error').length;
    return now;
  };
  await readPeople();
  const rounds = new Map();
  const pending = new Map();
  const answered = new Set();
  let assigned = 0;
  const startedAt = Date.now();
  const sampler = startSampler({
    rootPid: s.pid,
    everyMs: SAMPLE_MS,
    t0: startedAt,
    extra: () => ({ people: { ...live } }),
  });
  const assign = async (person, index) => {
    const round = rounds.get(person.id) ?? 0;
    rounds.set(person.id, round + 1);
    pending.set(person.id, Date.now() + 6_000);
    const w = workFor(person.name, index, round);
    await s.eval(`(() => {
      const board = ${state}.boards.find((b) => b.blockId === ${JSON.stringify(person.blockId)} && b.kind === 'quick') ?? ${state}.boards.find((b) => b.blockId === ${JSON.stringify(person.blockId)});
      window.office.send({ type: 'create_task', boardId: board.id, title: ${JSON.stringify(w.title)}, notes: ${JSON.stringify(w.notes)}, assignee: ${JSON.stringify(person.id)} });
    })()`);
    assigned++;
  };
  const feed = FAKE ? terminalFeed(people.map((p) => p.id)) : null;
  if (feed) {
    await s.eval(`for (const m of ${JSON.stringify(feed.first)}) __officeTerminalPush(m)`);
  }
  let feedUntil = 0;
  const pushFeed = async () => {
    // Ten seconds of pushes at ten a second, scheduled in the page.
    const chunk = feed.chunk(100);
    await s.eval(`(() => { const script = ${JSON.stringify(chunk)}; script.forEach((pushes, k) => setTimeout(() => { for (const m of pushes) __officeTerminalPush(m); }, k * 100)); })()`);
    feedUntil = Date.now() + 9_800;
  };

  const frameAt = MINUTES * 0.8 * 60_000;
  const breakdownAt = MINUTES * 0.9 * 60_000;
  let frames;
  let breakdown;
  let frameStarted = false;
  let breakdownStarted = false;
  log(`measuring for ${MINUTES} min`);
  while (Date.now() - startedAt < MINUTES * 60_000) {
    const elapsed = Date.now() - startedAt;
    if (FAKE) {
      const n = await s.eval(`${state}.company.employees.filter((e) => e.status.kind === 'working').length`);
      if (n !== EMPLOYEES) {
        await injectFake();
        live.reinjected++;
      }
      if (Date.now() >= feedUntil) await pushFeed();
    }
    const now = await readPeople();
    if (!FAKE) {
      for (const e of now) {
        const person = people.find((p) => p.id === e.id);
        if (!person) continue;
        const index = people.indexOf(person);
        if (e.kind === 'blocked_on_owner' && e.q && !answered.has(e.q)) {
          answered.add(e.q);
          await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(e.id)}, questionId: ${JSON.stringify(e.q)}, text: 'Go ahead with your best judgment and keep working.' })`);
        } else if (e.kind === 'error' && Date.now() > (pending.get(e.id) ?? 0)) {
          await s.eval(`window.office.send({ type: 'fresh_session', employeeId: ${JSON.stringify(e.id)} })`);
          pending.set(e.id, Date.now() + 15_000);
        } else if ((e.kind === 'idle' || e.kind === 'working') && !waiting.get(e.id) && Date.now() > (pending.get(e.id) ?? 0)) {
          // Nobody runs dry: whoever has nothing waiting behind the task they are on (or nothing at all) is handed the next one now.
          await assign(person, index);
        }
      }
    }
    if (!frameStarted && elapsed >= frameAt) {
      frameStarted = true;
      await s.cdp('Page.bringToFront');
      log('timing frames for 10 s');
      frames = s.eval('__office.measureFrames(10000)');
    }
    if (!breakdownStarted && elapsed >= breakdownAt) {
      breakdownStarted = true;
      log('breaking the memory down');
      breakdown = await takeBreakdown(s, main, page, sampler.samples);
    }
    await s.sleep(2000);
  }
  await sampler.stop();
  const samples = sampler.samples;
  log(`window over: ${samples.length} samples, ${assigned} tasks handed out`);

  // ---- Frames
  log('waiting for the frame timing');
  const timed = frames ? await frames : null;
  let frameResult = null;
  if (timed) {
    const sorted = [...timed.deltas].sort((a, b) => a - b);
    const avg = timed.deltas.reduce((a, b) => a + b, 0) / timed.deltas.length;
    frameResult = { frames: timed.deltas.length, fpsAvg: r2(1000 / avg), slowPct: r2((timed.deltas.filter((d) => d > 25).length / timed.deltas.length) * 100), p50ms: r2(sorted[Math.floor(sorted.length / 2)]), p99ms: r2(sorted[Math.floor(sorted.length * 0.99)]), drawCalls: timed.drawCalls, triangles: timed.triangles, renderCpuMs: timed.cpuMs === null ? null : r2(timed.cpuMs), gpuMs: timed.gpuMs === null ? null : r2(timed.gpuMs) };
  }

  // ---- Shots, at fixed framings
  const shots = await takeShots(s, people, log);

  // ---- Heap snapshots, last: they cost memory of their own.
  const heap = await takeHeapSnapshots(main, page, log);
  main.close();
  page.close();

  // ---- Result
  const summary = summarize(samples, { fromMin: MINUTES / 2, toMin: MINUTES });
  const ok = samples.filter((x) => !x.error);
  const working = ok.map((x) => x.people?.working ?? 0);
  const overlap = [...new Map(ok.flatMap((x) => x.others).map((o) => [o.pid, o])).values()];
  const reasons = [];
  if (overlap.length) reasons.push(`another Online Office app was running: ${overlap.map((o) => `pid ${o.pid} ${o.command}`).join('; ')}`);
  // The first two minutes are the ramp: main starts the fifteen tasks one after the other (about 4 s each, in git work), and each start is
  // acknowledged by a claude process of its own. After it everybody has a task running and the next one waiting.
  const steady = working.filter((_, i) => ok[i].tMin >= 2);
  if (steady.length && mean(steady) < EMPLOYEES - 0.5) reasons.push(`only ${mean(steady).toFixed(1)} of ${EMPLOYEES} people were working on average after the first two minutes`);
  if (!ok.length || ok.length < MINUTES * 5) reasons.push(`only ${ok.length} samples`);
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }).trim();
  const peakRow = ok.find((x) => x.countedMiB === summary.peakMiB) ?? ok[0];
  const other = r1(peakRow.classes.utility.mib + peakRow.classes.other.mib + peakRow.classes.ackers.mib);
  const tsv = [process.env.OFFICE_RAM_UNIT ?? 'R0', process.env.OFFICE_RAM_ROUND ?? (FAKE ? 'fake' : 'real'), sha, summary.peakMiB, peakRow.classes.main.mib, peakRow.classes.renderer.mib, peakRow.classes.gpu.mib, other, peakRow.classes.agents.mib, summary.slopeMiBPerMin, frameResult?.fpsAvg ?? '', frameResult?.slowPct ?? '', '-', new Date().toISOString()].join('\t');
  const result = {
    meta: { mode: FAKE ? 'fake' : 'real', minutes: MINUTES, sha, branch: execFileSync('git', ['branch', '--show-current'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }).trim(), viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: s.deviceScaleFactor }, out: OUT, startedAt: new Date(startedAt).toISOString(), model: HAIKU },
    valid: reasons.length === 0,
    invalidReasons: reasons,
    office: { ...office, plan: office.plan.map((p) => ({ story: p.story, deskId: p.deskId })) },
    summary,
    classTotals: { counted: 'main + renderer + gpu + utility + other + ackers', agents: 'the employees own claude/codex/hermes processes and their descendants' },
    working: { perSample: working, min: Math.min(...working), mean: r1(mean(working)), meanAfterTwoMinutes: steady.length ? r1(mean(steady)) : null, tasksHandedOut: assigned, reinjected: live.reinjected },
    frames: frameResult,
    breakdown,
    heap,
    shots,
    tsvColumns: 'unit round sha peakMiB mainMiB rendererMiB gpuMiB otherMiB agentsMiB slopeMiBmin fps slowPct visual at',
    tsv,
    samples: samples.map((x, i) => (x.error ? x : { tSec: x.tSec, countedMiB: x.countedMiB, agentsMiB: x.agentsMiB, classes: Object.fromEntries(Object.entries(x.classes).map(([k, v]) => [k, v.mib])), counts: Object.fromEntries(Object.entries(x.classes).map(([k, v]) => [k, v.n])), people: x.people, system: x.system, others: x.others, ...(x === peakRow ? { processes: x.rows } : {}) })),
  };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  log(`result written to ${join(OUT, 'result.json')}`);
  console.log(`RAM peak ${summary.peakMiB} MiB (limit 2048) at minute ${summary.peakAtMin}; slope ${summary.slopeMiBPerMin} MiB/min over minutes ${summary.slopeWindowMin.join(' to ')}; agents peak ${summary.maxAgentsMiB} MiB`);
  console.log(`per class at the peak: ${JSON.stringify(summary.atPeak)}; per class peak: ${JSON.stringify(summary.classPeak)}`);
  console.log(`working: min ${result.working.min} mean ${result.working.mean} of ${EMPLOYEES}; frames: ${frameResult ? `${frameResult.fpsAvg} fps, ${frameResult.slowPct}% slow` : 'not timed'}`);
  console.log(`TSV\t${tsv}`);
  if (!result.valid) throw new Error(`the run is INVALID: ${reasons.join(' | ')}`);
}

// ───────────────────────────── the breakdown ─────────────────────────────

function footprintCategories(pid) {
  const file = join(OUT, `footprint-${pid}.json`);
  try {
    execFileSync('footprint', ['-p', String(pid), '-j', file], { stdio: 'pipe', timeout: 60_000 });
    const p = JSON.parse(readFileSync(file, 'utf8')).processes[0];
    const MIB = 1024 * 1024;
    return {
      footprintMiB: r1(p.footprint / MIB),
      top: Object.entries(p.categories)
        .map(([name, c]) => ({ name, dirtyMiB: r1(c.dirty / MIB), swappedMiB: r1(c.swapped / MIB), regions: c.regions }))
        .sort((a, b) => b.dirtyMiB + b.swappedMiB - (a.dirtyMiB + a.swappedMiB))
        .slice(0, 8),
    };
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  } finally {
    rmSync(file, { force: true });
  }
}

async function takeBreakdown(s, main, page, samples) {
  const last = [...samples].reverse().find((x) => !x.error);
  const procs = last?.rows ?? [];
  const pidOf = (cls) => procs.filter((p) => p.cls === cls).map((p) => p.pid);
  const out = { at: new Date().toISOString(), processes: procs.slice(0, 25) };
  const heapUsage = await page.call('Runtime.getHeapUsage');
  const dom = await page.call('Memory.getDOMCounters').catch(() => null);
  out.renderer = {
    jsHeapUsedMiB: r1(heapUsage.usedSize / 2 ** 20),
    jsHeapTotalMiB: r1(heapUsage.totalSize / 2 ** 20),
    embedderHeapUsedMiB: r1((heapUsage.embedderHeapUsedSize ?? 0) / 2 ** 20),
    backingStorageMiB: r1((heapUsage.backingStorageSize ?? 0) / 2 ** 20),
    domNodes: dom?.nodes ?? null,
    domDocuments: dom?.documents ?? null,
    jsEventListeners: dom?.jsEventListeners ?? null,
    graphics: JSON.parse(await s.eval('JSON.stringify(__office.memory())')),
  };
  out.mainProcess = JSON.parse(await main.eval('JSON.stringify(globalThis.__officeRam())'));
  out.regions = {
    main: footprintCategories(procs.find((p) => p.cls === 'main')?.pid),
    renderer: pidOf('renderer').map(footprintCategories),
    gpu: pidOf('gpu').map(footprintCategories),
  };
  return out;
}

// ───────────────────────────── shots ─────────────────────────────

async function takeShots(s, people, log) {
  mkdirSync(SHOTS, { recursive: true });
  const taken = [];
  const take = async (name) => {
    log(`shot ${name}`);
    await s.sleep(1500);
    const path = await s.shot(`ram-${name}`);
    const to = join(SHOTS, `${name}.png`);
    copyFileSync(path, to);
    taken.push(to);
  };
  await s.cdp('Page.bringToFront');
  // 1. The iso overview: the owner on the top story, the camera at its farthest.
  await s.eval('__office.setCamera()');
  await s.eval('__office.ownerTo(2, 0, -12)');
  await s.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 720, y: 450, deltaX: 0, deltaY: 2000 });
  await take('1-iso-overview');
  // 2. A desk row with live monitors: the owner stands behind the first seated person of the ground floor.
  const seat = JSON.parse(await s.eval(`JSON.stringify(__office.state().avatars.filter((a) => a.floor === 0 && a.seated).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null)`));
  // Back to the default distance (27) for the rest.
  await s.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 720, y: 450, deltaX: 0, deltaY: -700 });
  if (seat) {
    await s.eval(`__office.ownerTo(0, ${seat.x}, ${seat.z + 1.4}); __office.teleport(${seat.x}, ${seat.z + 1.4}, 0)`);
    await s.sleep(2500);
    await take('2-desk-row');
    // 3. F at the desk: the camera flies into the monitor and the terminal opens over it.
    const near = await s.waitFor(`!!__officeMonitor.getState().near`, 6000).catch(() => false);
    if (near) {
      const who = await s.eval(`__officeMonitor.getState().near`);
      await s.press('KeyF', 'f');
      await s.waitFor(`__officeMonitor.getState().open === ${JSON.stringify(who)}`, 4000).catch(() => {});
      await s.waitFor(`!!document.querySelector('.term-frame.ready')`, 5000).catch(() => {});
      await s.sleep(800);
      await take('3-terminal-zoom');
      await s.press('Escape', 'Escape');
      await s.sleep(1500);
    } else log('the monitor offered no F prompt, so no terminal shot');
  } else log('nobody was seated on the ground floor, so no desk shots');
  // 4. Build mode with the catalog open.
  await s.eval('__office.ownerTo(2, 0, -12)');
  await s.sleep(1500);
  await s.press('KeyB', 'b');
  await s.waitFor(`!!${state}.build`, 4000).catch(() => {});
  await s.sleep(1500);
  await take('4-build-mode');
  await s.press('Escape', 'Escape');
  return taken;
}

// ───────────────────────────── heap snapshots ─────────────────────────────

async function takeHeapSnapshots(main, page, log) {
  const dir = join(OUT, 'heap');
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [name, target] of [['renderer', page], ['main', main]]) {
    const file = join(dir, `${name}.heapsnapshot`);
    try {
      log(`heap snapshot of ${name}`);
      await target.heapSnapshot(file);
      out[name] = summarizeHeap(file, 20);
      delete out[name].file;
    } catch (e) {
      out[name] = { error: String(e.message).slice(0, 300) };
    }
    if (!process.env.OFFICE_RAM_KEEP_HEAP) rmSync(file, { force: true });
  }
  return out;
}
