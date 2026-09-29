// Throwaway verification lever: drives headless Chrome over CDP so the world can be screenshotted
// and poked without the (unavailable) preview panel. Usage: node world/verify/cdp.mjs <scenario.mjs>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const OUT = '/tmp/office-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ url, width = 1280, height = 800, preload }) {
  rmSync('/tmp/office-chrome', { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir=/tmp/office-chrome',
      `--window-size=${width},${height}`,
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
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
      const frames = (m.params.stackTrace?.callFrames ?? []).slice(0, 12).map((f) => `      at ${f.functionName || '?'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber}`);
      logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}${m.params.type === 'error' ? '\n' + frames.join('\n') : ''}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await call('Runtime.enable');
  await call('Page.enable');
  if (preload) await call('Page.addScriptToEvaluateOnNewDocument', { source: preload });
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url });

  const api = {
    sleep,
    logs,
    async eval(expression) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
      return r.result.value;
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
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    async waitFor(expr, ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await api.eval(expr).catch(() => false)) return true;
        await sleep(200);
      }
      throw new Error(`timeout waiting for ${expr}`);
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
  return api;
}

const [, , scenario] = process.argv;
if (scenario) {
  const mod = await import(pathToFileURL(scenario).href);
  const s = await launch({ url: mod.url ?? 'http://localhost:5173/?demo=1', preload: mod.preload });
  try {
    await s.waitFor('!!window.__office');
    await mod.default(s);
  } finally {
    const uniq = [...new Set(s.logs)];
    console.log('console:', uniq.length ? uniq.join('\n  ') : '(clean)');
    s.close();
  }
  process.exit(0);
}
