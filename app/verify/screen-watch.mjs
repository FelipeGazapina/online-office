// Proves a command stays out of the owner's way. It runs the command, and every 250 ms it checks whether any process the
// command started is the frontmost application or owns a window on screen. It exits 1 if one ever does, else with the
// command's own exit code. macOS only.
// Usage: node verify/screen-watch.mjs node verify/cdp.mjs verify/e2e-real.mjs
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node verify/screen-watch.mjs <command> [args...]');
  process.exit(2);
}

const source = join(dirname(fileURLToPath(import.meta.url)), 'screen-sample.swift');
const sampler = join(tmpdir(), 'office-screen-sample');
if (!existsSync(sampler) || statSync(sampler).mtimeMs < statSync(source).mtimeMs) execFileSync('swiftc', ['-O', '-o', sampler, source]);

const sample = () => JSON.parse(execFileSync(sampler, { encoding: 'utf8' }));

// The command's own process tree, so the owner's own windows and apps never count.
function descendants(root) {
  const parent = new Map(
    execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([pid, ppid]) => [pid, ppid]),
  );
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parent) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true));
  }
  return tree;
}

const child = spawn(cmd, args, { stdio: 'inherit' });
let exitCode = null;
child.on('exit', (code) => (exitCode = code ?? 1));

const fronts = new Map();
const seenWindows = new Map();
let samples = 0;
let frontOfRun = 0;
const t0 = Date.now();
while (exitCode === null) {
  const tree = descendants(child.pid);
  const now = sample();
  samples++;
  fronts.set(now.front, (fronts.get(now.front) ?? 0) + 1);
  if (tree.has(now.frontPid)) frontOfRun++;
  for (const w of now.windows) if (tree.has(w.pid)) seenWindows.set(`${w.owner} "${w.name}" ${w.w}x${w.h}`, (seenWindows.get(`${w.owner} "${w.name}" ${w.w}x${w.h}`) ?? 0) + 1);
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`\nscreen watch: ${samples} samples over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('frontmost app:', [...fronts].map(([name, n]) => `${name} ${n}`).join(', '));
console.log('samples where a process of the run was frontmost:', frontOfRun);
console.log('windows of the run on screen:', seenWindows.size ? [...seenWindows].map(([w, n]) => `${w} (${n} samples)`).join(', ') : 'none');
const intruded = frontOfRun > 0 || seenWindows.size > 0;
console.log(intruded ? 'RESULT: the run reached the owner\'s screen' : 'RESULT: the run never took focus and never showed a window');
process.exit(intruded ? 1 : exitCode);
