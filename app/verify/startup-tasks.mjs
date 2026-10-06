// Every main-thread task of the built office's first seconds with the time it ran on the CPU beside the time it took, from a
// Chromium trace attached before the page starts. On a busy machine a task waits for a core and its wall time grows, but its
// CPU time stays what the work costs, so the CPU column compares builds that were measured under different load.
// Run from app/: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/startup-tasks.mjs
// OFFICE_STALLS_FIXTURE=default|floors3, OFFICE_STALLS_VISIBLE=1, OFFICE_STALLS_DATA_DIR=<dir> as in e2e-startup-stalls.mjs.
// OFFICE_TASKS_TRACE=<file>   keeps the raw trace.
// OFFICE_TASKS_MIN_MS=30   the shortest task (wall or CPU) to list.   OFFICE_TASKS_JSON=1   one JSON line instead of the table.
// A task's parts are the trace events directly under it, so the table names what ran (a timer, a script, layout, a paint).
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { launchHeld } from './startup-launch.mjs';

const minMs = Number(process.env.OFFICE_TASKS_MIN_MS ?? 30);
const CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink.user_timing'];

export function tasksOf(events, untilMs = 10_000) {
  const mainThreads = new Set();
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrRendererMain') mainThreads.add(`${e.pid}:${e.tid}`);
  const mine = events.filter((e) => e.ph === 'X' && mainThreads.has(`${e.pid}:${e.tid}`));
  const origin = Math.min(...mine.filter((e) => e.name === 'RunTask').map((e) => e.ts));
  // The page's clock starts at its navigation, which the trace records as the first navigationStart of the main frame.
  const nav = events.find((e) => e.name === 'navigationStart' && mainThreads.has(`${e.pid}:${e.tid}`));
  const zero = nav?.ts ?? origin;
  const tasks = mine.filter((e) => e.name === 'RunTask' && (e.ts - zero) / 1000 < untilMs).sort((a, b) => a.ts - b.ts);
  const timeline = (e) => e.cat.split(',').includes('devtools.timeline') && !e.cat.includes('disabled-by-default-v8.gc');
  const parts = mine.filter((e) => e.name !== 'RunTask' && timeline(e));
  return tasks.map((t) => {
    const inside = parts.filter((p) => p.ts >= t.ts && p.ts + p.dur <= t.ts + t.dur + 1).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    // Direct children only: an event that no other event inside the task contains.
    const direct = inside.filter((p) => !inside.some((q) => q !== p && q.ts <= p.ts && q.ts + q.dur >= p.ts + p.dur && (q.dur > p.dur || (q.dur === p.dur && inside.indexOf(q) < inside.indexOf(p)))));
    const label = (p) => {
      const d = p.args?.data ?? {};
      const where = d.functionName ? ` ${d.functionName} ${String(d.url ?? '').split('/').pop()}:${d.lineNumber}` : d.type ? ` ${d.type}` : d.url ? ` ${String(d.url).split('/').pop()}` : '';
      return `${p.name}${where} ${(p.dur / 1000).toFixed(0)}ms`;
    };
    return { start: Math.round((t.ts - zero) / 1000), wallMs: +(t.dur / 1000).toFixed(1), cpuMs: +((t.tdur ?? 0) / 1000).toFixed(1), parts: direct.filter((p) => p.dur >= 2000).slice(0, 6).map(label) };
  });
}

const trace = [];
const { fixture, visible } = await launchHeld({
  attach: (call) => [call('Tracing.start', { traceConfig: { includedCategories: CATEGORIES, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' })],
  finish: async (call, _page, events) => {
    const done = new Promise((resolve) => {
      const wait = setInterval(() => events.some((m) => m.method === 'Tracing.tracingComplete') && (clearInterval(wait), resolve()), 50);
    });
    await call('Tracing.end');
    await done;
    for (const m of events) if (m.method === 'Tracing.dataCollected') trace.push(...m.params.value);
  },
});

if (process.env.OFFICE_TASKS_TRACE) writeFileSync(process.env.OFFICE_TASKS_TRACE, JSON.stringify(trace));
const tasks = tasksOf(trace);
const long = tasks.filter((t) => t.wallMs >= minMs || t.cpuMs >= minMs);
const over = (key, ms) => tasks.filter((t) => t[key] > ms);
const total = (key, ms) => Math.round(over(key, ms).reduce((a, t) => a + t[key], 0));
const summary = { fixture, visible, load1: +loadavg()[0].toFixed(1), tasks: tasks.length, wallOver50: over('wallMs', 50).length, wallOver50Ms: total('wallMs', 50), cpuOver50: over('cpuMs', 50).length, cpuOver50Ms: total('cpuMs', 50), maxWallMs: Math.max(0, ...tasks.map((t) => t.wallMs)), maxCpuMs: Math.max(0, ...tasks.map((t) => t.cpuMs)) };
if (process.env.OFFICE_TASKS_JSON === '1') console.log(JSON.stringify({ ...summary, long }));
else {
  console.log(`fixture ${fixture}, window ${visible ? 'shown' : 'hidden'}, load ${loadavg().map((l) => l.toFixed(1)).join(' ')}`);
  console.log(JSON.stringify(summary));
  console.log('start ms   wall ms    cpu ms  parts');
  for (const t of long) console.log(`${String(t.start).padStart(8)}  ${String(t.wallMs).padStart(8)}  ${String(t.cpuMs).padStart(8)}  ${t.parts.join(' | ')}`);
}
