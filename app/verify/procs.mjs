// What the machine says about the app's processes: the tree under the Electron main PID, the memory each process holds
// (phys_footprint, the Activity Monitor Memory column), and the state of the machine around it. Shared by the run lock
// (cdp.mjs) and the RAM scenario (e2e-ram.mjs). macOS only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 * 1024;

// `agents` are the claude, codex and hermes processes of the employees' own sessions and everything they start (the only class the
// bar leaves out). `ackers` are the two spare claude processes the Acknowledger keeps for acknowledgements and triage (main/office/ack.ts):
// agent CLIs, but the app's own, so they count in the app's figure.
export const CLASSES = ['main', 'renderer', 'gpu', 'utility', 'other', 'ackers', 'agents'];
export const COUNTED = ['main', 'renderer', 'gpu', 'utility', 'other', 'ackers'];

// Every process: pid, parent pid and the command line.
export function processTable() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * MIB });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

export const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Start time as ps prints it, so a pid the system handed to another process later is not mistaken for the original.
export function startedAt(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// `root` and everything below it.
export function treeOf(table, root) {
  const kids = new Map();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out = [];
  const queue = table.filter((p) => p.pid === root);
  while (queue.length) {
    const p = queue.shift();
    out.push(p);
    queue.push(...(kids.get(p.pid) ?? []));
  }
  return out;
}

// The executable's file name, whatever its path holds (spaces included).
const exeName = (command) => {
  const head = command.split(/ --?[a-z]/i)[0];
  return head.slice(head.lastIndexOf('/') + 1).trim().split(/\s+/)[0] ?? '';
};
// An agent CLI the app runs: Claude Code's native binary, codex, hermes.
const isAgentRoot = (command) => /claude-agent-sdk/.test(command) || /^(claude|codex|hermes)(\.exe)?$/.test(exeName(command));
// The Acknowledger's one-shot calls run a single turn with no tools and keep no session (see OneShot in ack.ts); an employee's
// session never does, because it needs its tools and resumes its session.
const isAckerRoot = (command) => isAgentRoot(command) && /--max-turns 1(\s|$)/.test(command) && /--no-session-persistence/.test(command);

// Where each process of the tree belongs. Anything at or below an agent CLI is the agent's, even a git or a node it started.
export function classify(table, root) {
  const tree = treeOf(table, root);
  const byPid = new Map(tree.map((p) => [p.pid, p]));
  const agentic = new Map();
  // 'ackers', 'agents' or null for a process: the nearest agent CLI above it (or itself) decides.
  const underAgent = (p) => {
    if (p.pid === root) return null;
    if (!agentic.has(p.pid)) agentic.set(p.pid, isAckerRoot(p.command) ? 'ackers' : isAgentRoot(p.command) ? 'agents' : (byPid.has(p.ppid) ? underAgent(byPid.get(p.ppid)) : null));
    return agentic.get(p.pid);
  };
  return tree.map((p) => {
    let cls;
    if (p.pid === root) cls = 'main';
    else if (underAgent(p)) cls = underAgent(p);
    else if (/--type=renderer/.test(p.command)) cls = 'renderer';
    else if (/--type=gpu-process/.test(p.command)) cls = 'gpu';
    else if (/--type=utility|crashpad/.test(p.command)) cls = 'utility';
    else cls = 'other';
    return { ...p, cls };
  });
}

let helper;
// The compiled helper that reads phys_footprint. Built once per source version into the temp folder.
function footprintHelper() {
  if (helper) return helper;
  const source = resolve(HERE, 'phys-footprint.c');
  const stamp = String(Math.floor(execFileSync('stat', ['-f', '%m', source], { encoding: 'utf8' }).trim() || 0));
  const dir = join(tmpdir(), 'office-ram-tools');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `phys-footprint-${stamp}`);
  if (!existsSync(bin)) execFileSync('cc', ['-O2', '-o', bin, source], { stdio: 'pipe' });
  helper = bin;
  return bin;
}

// phys_footprint and its lifetime peak, in MiB, per pid. A pid that has gone is left out.
export function footprints(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const text = execFileSync(footprintHelper(), pids.map(String), { encoding: 'utf8', maxBuffer: 8 * MIB });
  for (const line of text.split('\n')) {
    const [pid, now, peak] = line.split(' ').map(Number);
    if (pid) out.set(pid, { mib: now / MIB, peakMib: peak / MIB });
  }
  return out;
}

// Swap in use, the kernel's memory pressure level (1 normal, 2 warning, 4 critical) and the free percentage the system reports.
export function systemMemory() {
  const swap = /used = ([\d.]+)M/.exec(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }));
  const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).trim());
  const free = /free percentage: (\d+)%/.exec(execFileSync('memory_pressure', { encoding: 'utf8', timeout: 10_000 }));
  return { swapUsedMiB: swap ? Number(swap[1]) : null, pressureLevel: level, freePct: free ? Number(free[1]) : null };
}

// Electron apps of ours that are running and are not in the tree under `root`: another test run, a beta, the installed app.
// Helpers (--type=) are left out, one main per app is enough to name it.
export function otherOfficeApps(table, root) {
  const mine = new Set(root ? treeOf(table, root).map((p) => p.pid) : []);
  return table.filter(
    (p) =>
      !mine.has(p.pid) &&
      !/--type=/.test(p.command) &&
      /(Electron\.app\/Contents\/MacOS\/Electron|Online Office\.app\/Contents\/MacOS\/Online Office)( |$)/.test(p.command) &&
      /online-office|Online Office/i.test(p.command),
  );
}
