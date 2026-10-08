// Drives the real Electron app over the Chrome DevTools Protocol so the office can be screenshotted and poked.
// Usage: node verify/cdp.mjs <scenario.mjs>   (run `pnpm build` first; it launches the built app)
// If the owner runs the beta from out/, build to a separate folder so the tests never rewrite it under him:
//   pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs <scenario.mjs>
// A scenario exports `env` (variables for the app) and a default async function that receives the driver.
// Its second argument is `{ launch }`, so a scenario can quit the app and start it again on the same OFFICE_DATA_DIR.
// Every instance started this way is closed when the scenario ends, whether it passed or not.
// Every launch waits for the machine-wide run lock (run-lock.mjs) and holds it until the apps have quit, so two runs never overlap
// and a memory or frame figure is never taken beside another app of ours. It cannot be turned off.
// A scenario may also export `viewport` ({ width, height }), `prepare` (an async function run once the lock is held and before the
// app starts, for work that must be in place at startup such as a data folder) and `exclusive` (true: also wait until no other
// Online Office app is running, lock or not).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquire, release } from './run-lock.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Two worktrees running end-to-end tests at once need different ports, or each driver talks to the other's app.
const PORT = Number(process.env.OFFICE_CDP_PORT ?? 9333);
export const OUT = '/tmp/office-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launched = [];

export async function launch({ env = {}, width = 1280, height = 800, exe, exclusive = false } = {}) {
  await acquire(process.argv[2] ? basename(process.argv[2]) : basename(process.argv[1] ?? 'cdp'), { exclusive });
  mkdirSync(OUT, { recursive: true });
  const electron = createRequire(import.meta.url)('electron');
  // Set by Electron-based hosts (editors, agent shells). With it the binary runs as plain Node and never opens a window.
  const { ELECTRON_RUN_AS_NODE: _, ...inherited } = process.env;
  const entry = process.env.OFFICE_OUT_DIR ? join(resolve(APP_DIR, process.env.OFFICE_OUT_DIR), 'main', 'index.js') : '.';
  // A scenario that must look inside the main process names a port in its env: the Node inspector listens there (verify/inspector.mjs).
  const inspect = env.OFFICE_INSPECT_PORT ? [`--inspect=127.0.0.1:${env.OFFICE_INSPECT_PORT}`] : [];
  const proc = spawn(exe ?? electron, [...(exe ? [] : [entry]), `--remote-debugging-port=${PORT}`, ...inspect], {
    cwd: APP_DIR,
    // OFFICE_TEST_RUN keeps the window hidden and out of the Dock. A scenario can set it to '' to watch a run by eye.
    env: { ...inherited, OFFICE_TEST_RUN: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so the fallback kill below also takes the Claude children with it.
    detached: true,
  });
  const mainLogs = [];
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (d) => mainLogs.push(d.toString().trimEnd()));
  let exited = false;
  let closing = false;
  proc.on('exit', (code, signal) => {
    exited = true;
    // Quitting on purpose goes through close(). Anything else is the window being closed or the app dying.
    if (!closing) mainLogs.push(`[driver] the app exited on its own: code=${code} signal=${signal}`);
  });

  let targets = [];
  for (let i = 0; i < 100 && !exited; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.some((t) => t.type === 'page' && t.url.startsWith('file:'))) break;
    } catch {}
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
  if (!page) {
    // Nothing owns this app yet, so nothing else would ever close it.
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {}
    throw new Error(`Electron did not open a window. Main process said:\n${mainLogs.join('\n')}`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') logs.push(`${m.params.type}: ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
  };
  // Without this a closed window leaves every pending call waiting, and Node exits with an unsettled top-level await.
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the app closed the DevTools connection (window closed or app quit)'));
    pending.clear();
  };
  // A send on a closed socket is dropped without an error, so a call made after the app quit would wait forever.
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('the DevTools connection is closed'));
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const api = {
    sleep,
    // The Electron main process. Everything the app runs is below it.
    pid: proc.pid,
    port: PORT,
    logs,
    mainLogs,
    async eval(expression) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
      return r.result.value;
    },
    // Shrinks or grows the page the way a window resize would, so a scenario can test layout at a new size.
    async resize(width, height) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async shot(name) {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const path = `${OUT}/${name}.png`;
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      console.log('shot', path);
      return path;
    },
    async key(type, code, key = code) {
      const text = key === 'Enter' && type === 'keyDown' ? '\r' : undefined;
      await call('Input.dispatchKeyEvent', { type, code, key, text, windowsVirtualKeyCode: key === 'Enter' ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 });
    },
    async type(text) {
      await call('Input.insertText', { text });
    },
    async press(code, key = code) {
      await api.key('keyDown', code, key);
      await api.key('keyUp', code, key);
    },
    // A key the way a keyboard sends it: with its virtual key code, so Tab moves focus and Enter presses a button, and with
    // modifiers (Alt 1, Ctrl 2, Meta 4, Shift 8) so Cmd+Enter carries the meta key. `press` sends no code for keys such as Tab.
    async chord(key, modifiers = 0) {
      const vk = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key] ?? key.toUpperCase().charCodeAt(0);
      const base = { code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key, key, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
      await call('Input.dispatchKeyEvent', { ...base, type: text && !(modifiers & 6) ? 'keyDown' : 'rawKeyDown', ...(text && !(modifiers & 6) ? { text } : {}) });
      await call('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    },
    async waitFor(expr, ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await api.eval(expr).catch(() => false)) return true;
        await sleep(200);
      }
      throw new Error(`timeout waiting for ${expr}`);
    },
    // Clicks the first element matching `selector` whose text contains `text`. Returns whether one was found.
    clickText: (selector, text) =>
      api.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.innerText.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`),
    // Real pointer input at viewport pixels. These are trusted events, so they reach the pointer handlers of the 3D
    // scene, which element.click() never does. A scenario about clicking uses these and nothing else.
    async mouse(type, x, y, buttons = 0) {
      // A release names the button that came up, even though no button is held afterwards.
      await call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    },
    async click(x, y) {
      await api.mouse('mouseMoved', x, y);
      await api.mouse('mousePressed', x, y, 1);
      await api.mouse('mouseReleased', x, y);
    },
    async drag(from, to, steps = 10) {
      await api.mouse('mouseMoved', from.x, from.y);
      await api.mouse('mousePressed', from.x, from.y, 1);
      for (let i = 1; i <= steps; i++) await api.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
      await api.mouse('mouseReleased', to.x, to.y);
    },
    // The center of the first element matching `selector` whose text contains `text`, or null.
    center: (selector, text = '') =>
      api.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`),
    async clickOn(selector, text) {
      const at = await api.center(selector, text);
      if (!at) throw new Error(`nothing to click for ${selector} ${text ?? ''}`);
      await api.click(at.x, at.y);
      return at;
    },
    async close() {
      closing = true;
      ws.close();
      if (!exited) proc.kill('SIGTERM');
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      // SIGTERM lets Electron run will-quit, which stops the Claude sessions. If it hangs, take the group down.
      if (!exited) process.kill(-proc.pid, 'SIGKILL');
    },
    // For a signal: no waiting, the whole process group goes.
    killNow() {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    },
  };
  launched.push(api);
  return api;
}

// A signal still takes the apps down before the process leaves, and leaving releases the run lock.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    for (const app of launched) app.killNow();
    process.exit(130);
  });
}

const [, , scenario] = process.argv;
if (scenario) {
  const mod = await import(pathToFileURL(resolve(scenario)).href);
  await acquire(basename(scenario), { exclusive: !!mod.exclusive });
  await mod.prepare?.();
  const s = await launch({ env: mod.env, exclusive: !!mod.exclusive, ...mod.viewport }).catch((e) => {
    release();
    throw e;
  });
  let failed = false;
  try {
    await s.waitFor('!!window.__office && !!window.office');
    await mod.default(s, { launch });
  } catch (e) {
    failed = true;
    console.error('FAILED:', e.message);
    await mod.diagnose?.(s).catch((err) => console.error('diagnose failed:', err.message));
  } finally {
    const uniq = [...new Set(s.logs)];
    console.log('renderer console:', uniq.length ? '\n  ' + uniq.join('\n  ') : '(clean)');
    const main = s.mainLogs.join('\n').trim();
    console.log('main process output:', main ? '\n  ' + main.replace(/\n/g, '\n  ') : '(empty)');
    for (const app of launched) await app.close();
    release();
  }
  process.exit(failed ? 1 : 0);
}
