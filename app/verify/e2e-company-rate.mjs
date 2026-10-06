// Pass rate of the company scenario: runs e2e-company.mjs N times and prints a pass/fail table per acceptance line.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/e2e-company-rate.mjs --n 10 --model haiku|default [--parallel 2] [--port 9341]
// haiku sets OFFICE_CLAUDE_MODEL to the cheap test model; default sets the app's default model, claude-sonnet-5-5.
// Each trial gets its own TMPDIR (data dir, scratch repo) and CDP port, removed afterwards. Results: /tmp/g2-rate-<model>-<stamp>.json
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const N = Number(arg('n', 10));
const model = arg('model', 'default');
const parallel = Number(arg('parallel', 1));
const basePort = Number(arg('port', 9341));
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = 'claude-sonnet-5-5'; // the app's own default (README OFFICE_CLAUDE_MODEL); the scenario would otherwise fall back to haiku
const HAIKU = 'claude-haiku-4-5-20251001';

const key = (line) => line.replace(/\([^)]*\)/g, '').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();

function trial(i, slot) {
  const tmp = mkdtempSync(join(tmpdir(), 'g2-rate-'));
  const env = { ...process.env, TMPDIR: tmp, OFFICE_CDP_PORT: String(basePort + slot * 100), OFFICE_OUT_DIR: process.env.OFFICE_OUT_DIR ?? 'out/verify' };
  if (model === 'haiku') env.OFFICE_CLAUDE_MODEL = HAIKU;
  else env.OFFICE_CLAUDE_MODEL = DEFAULT_MODEL;
  return new Promise((done) => {
    const p = spawn('node', ['verify/cdp.mjs', 'verify/e2e-company.mjs'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', () => {
      const lines = [...out.matchAll(/^(PASS|FAIL): (.*)$/gm)].map((m) => ({ ok: m[1] === 'PASS', key: key(m[2]), text: m[2] }));
      writeFileSync(`/tmp/g2-rate-${model}-trial${i}.log`, out);
      rmSync(tmp, { recursive: true, force: true });
      console.log(`trial ${i + 1}/${N}: ${lines.filter((l) => l.ok).length}/${lines.length} lines${/SUMMARY (\d+)\/\1 /.test(out) ? ' ALL PASS' : ''}`);
      done(lines);
    });
  });
}

const trials = [];
let next = 0;
await Promise.all(Array.from({ length: parallel }, async (_, slot) => {
  while (next < N) { const i = next++; trials[i] = await trial(i, slot); }
}));

const keys = [...new Set(trials.flatMap((t) => t.map((l) => l.key)))];
const passOf = (t, k) => t.some((l) => l.key === k && l.ok);
const full = trials.filter((t) => t.length > 0 && t.every((l) => l.ok) && keys.every((k) => passOf(t, k))).length;
console.log(`\nmodel ${model}, N=${N}`);
for (const k of keys) console.log(`${String(trials.filter((t) => passOf(t, k)).length).padStart(2)}/${N}  ${k}`);
console.log(`${String(full).padStart(2)}/${N}  ALL LINES in one trial`);
writeFileSync(`/tmp/g2-rate-${model}-${Date.now()}.json`, JSON.stringify({ model, N, keys, trials }, null, 1));
