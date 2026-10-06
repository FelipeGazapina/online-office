// CPU profile of the built office's first seconds, attached before the page starts, with each busy stretch named by its top frames.
// Run from app/: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/startup-profile.mjs
// OFFICE_STALLS_FIXTURE=default|floors3, OFFICE_STALLS_VISIBLE=1, OFFICE_STALLS_DATA_DIR=<dir> as in e2e-startup-stalls.mjs.
// OFFICE_PROFILE_OUT=<file>   where the .cpuprofile goes (default /tmp/office-shots/startup.cpuprofile).
// OFFICE_PROFILE_MIN_MS=50    the shortest stretch to report.
// OFFICE_PROFILE_TOP=16       how many frames to list per stretch.
// node verify/startup-profile.mjs --analyze <file.cpuprofile>   reports a profile that was already taken.
// The page is held at its first instruction by Target.setAutoAttach, so the profile covers the whole load. A busy stretch is
// a run of samples with no idle gap over 5 ms; the page's own long-task list is printed beside it to match them by order.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupDataDir } from './startup-fixture.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minMs = Number(process.env.OFFICE_PROFILE_MIN_MS ?? 50);
const topN = Number(process.env.OFFICE_PROFILE_TOP ?? 16);

export function report(profile, stalls = []) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
  };
  let t = profile.startTime;
  const at = profile.samples.map((_, i) => (t += profile.timeDeltas[i]));
  const rel = (x) => (x - profile.startTime) / 1000;
  const stretches = [];
  let cur = null;
  for (let i = 0; i < profile.samples.length; i++) {
    if (byId.get(profile.samples[i]).callFrame.functionName === '(idle)') {
      if (cur && rel(at[i]) - cur.end > 5) stretches.push(cur), (cur = null);
      continue;
    }
    cur ??= { start: rel(at[i - 1] ?? at[i]), end: 0, idx: [] };
    cur.end = rel(at[i]);
    cur.idx.push(i);
  }
  if (cur) stretches.push(cur);
  console.log(`long tasks the page saw (start+duration ms): ${stalls.map(([s, d]) => `${s}+${d}`).join(' ') || 'none'}`);
  for (const s of stretches.filter((x) => x.end - x.start >= minMs)) {
    const self = new Map();
    const incl = new Map();
    for (const i of s.idx) {
      const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000;
      let id = profile.samples[i];
      const l0 = label(byId.get(id));
      self.set(l0, (self.get(l0) ?? 0) + dt);
      const seen = new Set();
      for (; id !== undefined; id = parent.get(id)) {
        const l = label(byId.get(id));
        if (!seen.has(l)) incl.set(l, (incl.get(l) ?? 0) + dt), seen.add(l);
      }
    }
    const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, v]) => `    ${v.toFixed(0).padStart(5)} ms  ${l}`).join('\n');
    console.log(`\nbusy ${s.start.toFixed(0)}..${s.end.toFixed(0)} ms (${(s.end - s.start).toFixed(0)} ms)\n  self:\n${top(self, Math.ceil(topN / 2))}\n  inclusive:\n${top(incl, topN)}`);
  }
}

async function profileLaunch() {
  const fixture = process.env.OFFICE_STALLS_FIXTURE ?? 'default';
  const visible = process.env.OFFICE_STALLS_VISIBLE === '1';
  const port = Number(process.env.OFFICE_CDP_PORT ?? 9333);
  const dataDir = process.env.OFFICE_STALLS_DATA_DIR ?? startupDataDir(fixture).dataDir;
  const electron = createRequire(import.meta.url)('electron');
  const entry = process.env.OFFICE_OUT_DIR ? join(resolve(APP_DIR, process.env.OFFICE_OUT_DIR), 'main', 'index.js') : '.';
  const { ELECTRON_RUN_AS_NODE: _, ...inherited } = process.env;
  const proc = spawn(electron, [entry, `--remote-debugging-port=${port}`], {
    cwd: APP_DIR,
    env: { ...inherited, OFFICE_DATA_DIR: dataDir, OFFICE_ACK: '0', OFFICE_TEST_RUN: visible ? '' : '1' },
    stdio: 'ignore',
    detached: true,
  });
  try {
    let version;
    for (let i = 0; i < 4000 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json(), () => undefined);
      if (!version) await sleep(5);
    }
    if (!version) throw new Error('the app never opened its DevTools port');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    let pageSession;
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    // Everything for the page goes out at once and the page is resumed last. A paused page answers nothing until it runs.
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'page' && !pageSession) {
        pageSession = m.params.sessionId;
        const sent = [
          call('Profiler.enable', {}, pageSession),
          call('Profiler.setSamplingInterval', { interval: 200 }, pageSession),
          call('Profiler.start', {}, pageSession),
          call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__stalls = []; new PerformanceObserver((l) => window.__stalls.push(...l.getEntries().map((e) => [Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true })` }, pageSession),
          call('Runtime.runIfWaitingForDebugger', {}, pageSession),
        ];
        void Promise.all(sent);
      }
    };
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    for (let i = 0; i < 400 && !pageSession; i++) await sleep(50);
    if (!pageSession) throw new Error('the app opened no page');
    await sleep(500);
    for (let i = 0; i < 400; i++) {
      const now = await call('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true }, pageSession).then((r) => r.result.value, () => 0);
      if (now > 10_500) break;
      await sleep(250);
    }
    const stalls = (await call('Runtime.evaluate', { expression: 'window.__stalls', returnByValue: true }, pageSession)).result.value ?? [];
    const { profile } = await call('Profiler.stop', {}, pageSession);
    const out = process.env.OFFICE_PROFILE_OUT ?? '/tmp/office-shots/startup.cpuprofile';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(profile));
    console.log(`fixture ${fixture}, window ${visible ? 'shown' : 'hidden'}, load ${loadavg().map((l) => l.toFixed(1)).join(' ')}, profile ${out}`);
    report(profile, stalls.filter(([s]) => s < 10_000));
    ws.close();
  } finally {
    // The app is its own process group, so this takes its helpers with it and nothing else.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-proc.pid, signal);
      } catch {}
      await sleep(1000);
    }
  }
}

if (process.argv[2] === '--analyze') report(JSON.parse(readFileSync(process.argv[3], 'utf8')));
else await profileLaunch();
