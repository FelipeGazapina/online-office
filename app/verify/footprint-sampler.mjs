// Samples the memory of the app's whole process tree on a fixed beat. One sample reads, for every process under the Electron main PID,
// its phys_footprint (the Activity Monitor Memory column), sorts the processes into classes (procs.mjs), and records the machine's
// swap and memory pressure and any other Online Office app that is running (listed under `others`, each with its kind). The figure of the bar is the sum of COUNTED classes;
// employees' own agent processes are summed apart.
import { CLASSES, COUNTED, classify, footprints, isAckerRoot, otherOfficeApps, processTable, systemMemory } from './procs.mjs';

const r1 = (n) => +n.toFixed(1);

export function sampleOnce(rootPid) {
  const table = processTable();
  const procs = classify(table, rootPid);
  const fp = footprints(procs.map((p) => p.pid));
  const classes = Object.fromEntries(CLASSES.map((c) => [c, { mib: 0, n: 0 }]));
  const rows = [];
  for (const p of procs) {
    const f = fp.get(p.pid);
    if (!f) continue;
    classes[p.cls].mib += f.mib;
    classes[p.cls].n++;
    rows.push({ pid: p.pid, ppid: p.ppid, cls: p.cls, mib: r1(f.mib), peakMib: r1(f.peakMib), command: p.command.length > 160 ? `${p.command.slice(0, 160)}...` : p.command });
  }
  for (const c of CLASSES) classes[c].mib = r1(classes[c].mib);
  const countedMiB = r1(COUNTED.reduce((sum, c) => sum + classes[c].mib, 0));
  // Every other Online Office app, with its kind: only a `test` one makes a run invalid (procs.mjs officeAppKind).
  const others = otherOfficeApps(table, rootPid).map((p) => ({ pid: p.pid, kind: p.kind, command: p.command.slice(0, 120) }));
  return { classes, countedMiB, agentsMiB: classes.agents.mib, rows: rows.sort((a, b) => b.mib - a.mib), others, system: systemMemory() };
}

// Least squares slope of y on x.
export function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den === 0 ? null : num / den;
}

// Peak, per-class peak and the slope of the total (MiB per minute) over [fromMin, toMin] of the samples.
export function summarize(all, { fromMin, toMin, rampMin = 2 }) {
  const samples = all.filter((s) => !s.error);
  const classPeak = Object.fromEntries(CLASSES.map((c) => [c, r1(Math.max(0, ...samples.map((s) => s.classes[c].mib)))]));
  const top = samples.reduce((best, s) => (!best || s.countedMiB > best.countedMiB ? s : best), null);
  const window = samples.filter((s) => s.tMin >= fromMin && s.tMin <= toMin);
  const m = slope(window.map((s) => ({ x: s.tMin, y: s.countedMiB })));
  const agents = slope(window.map((s) => ({ x: s.tMin, y: s.agentsMiB })));
  return {
    peakMiB: top ? top.countedMiB : null,
    peakAtMin: top ? +top.tMin.toFixed(2) : null,
    // The same after the ramp (`rampMin`: the first sample at which everybody was working), when the tasks have started and their acknowledgements are done.
    peakAfterRampMiB: (() => {
      const after = samples.filter((s) => s.tMin >= rampMin);
      return after.length ? Math.max(...after.map((s) => s.countedMiB)) : null;
    })(),
    // The class values at the sample that held the peak, so they add up to it.
    atPeak: top ? Object.fromEntries(CLASSES.map((c) => [c, top.classes[c].mib])) : null,
    classPeak,
    slopeMiBPerMin: m === null ? null : r1(m),
    agentsSlopeMiBPerMin: agents === null ? null : r1(agents),
    slopeWindowMin: [fromMin, toMin],
    slopeSamples: window.length,
    maxAgentsMiB: r1(Math.max(0, ...samples.map((s) => s.agentsMiB))),
    maxSwapUsedMiB: Math.max(0, ...samples.map((s) => s.system.swapUsedMiB ?? 0)),
    maxPressureLevel: Math.max(0, ...samples.map((s) => s.system.pressureLevel ?? 0)),
  };
}

// Starts sampling every `everyMs` and calls `extra()` for what the scenario knows at that moment (how many are working). Returns
// { samples, stop }. A sample that throws is recorded as an error and sampling goes on.
export function startSampler({ rootPid, everyMs = 10_000, extra = () => ({}), t0 = Date.now() }) {
  const samples = [];
  let stopped = false;
  let timer;
  let inFlight = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    const at = Date.now();
    try {
      const s = sampleOnce(rootPid);
      samples.push({ tSec: r1((at - t0) / 1000), tMin: (at - t0) / 60_000, ...s, ...(await extra()) });
    } catch (e) {
      samples.push({ tSec: r1((at - t0) / 1000), tMin: (at - t0) / 60_000, error: String(e.message ?? e) });
    }
    if (!stopped) timer = setTimeout(() => (inFlight = tick()), Math.max(0, everyMs - (Date.now() - at)));
  };
  inFlight = tick();
  return {
    samples,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

// The ramp ends at the first sample with at least `people - 1` working: main starts the tasks one after the other, each start is a few
// seconds of git work, and the page only hears of a person working when main gets to send the snapshot. Null if it never did.
export function rampEnd(samples, people) {
  const at = samples.find((s) => !s.error && (s.people?.working ?? 0) >= people - 1);
  return at ? at.tMin : null;
}

const percentile = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null);

// The acknowledger's processes on a faster beat than the memory samples: every `everyMs` the table is read and the claude processes that
// run a single turn with no session (procs.mjs isAckerRoot) under `rootPid` are counted. Gives how many were alive at most, how many
// were ever started, how long each lived (to within one beat) and how the ticks split by the number alive. The 10 s samples can step
// over a burst of short lives; this cannot, unless one is shorter than the beat.
export function startAckerCensus({ rootPid, everyMs = 500, t0 = Date.now() }) {
  const seen = new Map();
  const alive = [];
  let stopped = false;
  let timer;
  const tick = () => {
    if (stopped) return;
    const at = Date.now();
    try {
      const table = processTable();
      const tree = new Set(classify(table, rootPid).map((p) => p.pid));
      const now = table.filter((p) => tree.has(p.pid) && isAckerRoot(p.command));
      const sec = (at - t0) / 1000;
      for (const p of now) {
        const row = seen.get(p.pid) ?? { pid: p.pid, firstSec: sec, lastSec: sec };
        row.lastSec = sec;
        seen.set(p.pid, row);
      }
      alive.push(now.length);
    } catch {}
    if (!stopped) timer = setTimeout(tick, Math.max(0, everyMs - (Date.now() - at)));
  };
  tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      const lives = [...seen.values()].map((r) => +(r.lastSec - r.firstSec + everyMs / 1000).toFixed(1));
      const hist = {};
      for (const n of alive) hist[n] = (hist[n] ?? 0) + 1;
      return {
        everyMs,
        ticks: alive.length,
        maxAlive: Math.max(0, ...alive),
        meanAlive: +(alive.reduce((a, b) => a + b, 0) / Math.max(1, alive.length)).toFixed(2),
        ticksByAlive: hist,
        started: seen.size,
        lifeSec: { p50: percentile(lives, 0.5), p95: percentile(lives, 0.95), max: Math.max(0, ...lives) },
        processes: [...seen.values()].map((r) => ({ pid: r.pid, fromSec: +r.firstSec.toFixed(1), lifeSec: +(r.lastSec - r.firstSec + everyMs / 1000).toFixed(1) })),
      };
    },
  };
}
