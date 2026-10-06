// Launches the built office with its page held at the first instruction, so a profiler or a trace can be attached before
// anything runs, lets it run for the first seconds, and closes it. startup-profile.mjs and startup-tasks.mjs share this.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupDataDir } from './startup-fixture.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page records its own long tasks from the first instruction, so a profile can be matched against what the page saw. */
export const RECORD_LONG_TASKS = `window.__stalls = []; new PerformanceObserver((l) => window.__stalls.push(...l.getEntries().map((e) => [Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true })`;

/**
 * `attach(call, page)` runs once the page exists and before it runs: it sends what must be in place first, and `call` reaches
 * the browser when `page` is left out. `finish(call, page, events)` runs after the page passed `untilMs`, with every message
 * the browser sent that was not an answer to a call.
 */
export async function launchHeld({ attach, finish, untilMs = 10_500 }) {
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
    const events = [];
    let page;
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
      } else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'page' && !page) {
        page = m.params.sessionId;
        void Promise.all([...attach(call, page), call('Runtime.runIfWaitingForDebugger', {}, page)]);
      } else {
        events.push(m);
      }
    };
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    for (let i = 0; i < 400 && !page; i++) await sleep(50);
    if (!page) throw new Error('the app opened no page');
    await sleep(500);
    for (let i = 0; i < 400; i++) {
      const now = await call('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true }, page).then((r) => r.result.value, () => 0);
      if (now > untilMs) break;
      await sleep(250);
    }
    const stalls = (await call('Runtime.evaluate', { expression: 'window.__stalls', returnByValue: true }, page)).result.value ?? [];
    await finish(call, page, events, stalls);
    ws.close();
    return { fixture, visible };
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
