// A machine-wide lock for end-to-end runs. Memory and frame figures are only valid when no other app run of ours overlaps, and the
// machine has 16 GB, so every launch through cdp.mjs waits here until the run before it has quit its apps.
//
// The lock is a folder whose name is fixed and whose only content is `owner.json` (pid, process start time, scenario). It is made
// by renaming a finished folder onto the name, which fails while one stands there, so taking it is atomic and a lock never exists
// without an owner. A lock whose owner is gone (pid dead, or the pid now belongs to a process that started later) is stale and is
// taken over. The holder releases when its process exits, which includes the signals cdp.mjs turns into an exit.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, otherOfficeApps, processTable, startedAt } from './procs.mjs';

export const LOCK_DIR = '/tmp/online-office-run.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let held = false;

const readOwner = () => {
  try {
    return JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
};

const ownerIsAlive = (o) => !!o && isAlive(o.pid) && (!o.startedAt || startedAt(o.pid) === o.startedAt);

function tryTake(scenario) {
  const draft = join('/tmp', `office-run-lock-${process.pid}-${Date.now()}`);
  mkdirSync(draft);
  writeFileSync(join(draft, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: startedAt(process.pid), scenario, since: Date.now() }));
  try {
    renameSync(draft, LOCK_DIR);
    return true;
  } catch (e) {
    rmSync(draft, { recursive: true, force: true });
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'EISDIR') return false;
    throw e;
  }
}

// Moves a dead owner's lock aside. If what was moved turns out to belong to a live owner (another waiter took the stale one over
// in between and made a new lock), it goes back.
function reap(dead) {
  const aside = `${LOCK_DIR}.reap-${process.pid}`;
  try {
    renameSync(LOCK_DIR, aside);
  } catch {
    return;
  }
  const moved = (() => {
    try {
      return JSON.parse(readFileSync(join(aside, 'owner.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  if (moved && moved.pid !== dead.pid && ownerIsAlive(moved)) {
    try {
      renameSync(aside, LOCK_DIR);
      return;
    } catch {}
  }
  rmSync(aside, { recursive: true, force: true });
}

export function release() {
  if (!held) return;
  held = false;
  if (readOwner()?.pid === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
}

const out = (msg) => console.log(`[run-lock] ${msg}`);

// Waits for the lock and takes it. Taking it twice in one process is one hold. `exclusive` also waits until no other Online Office
// app is running at all, whether it holds the lock or not (an older cdp.mjs does not know the lock), which a memory figure needs.
export async function acquire(scenario, { exclusive = false, maxWaitMs = 60 * 60_000 } = {}) {
  if (held) return;
  const t0 = Date.now();
  let lastNote = 0;
  const note = (msg) => {
    if (Date.now() - lastNote < 30_000 && lastNote) return;
    lastNote = Date.now();
    out(msg);
  };
  for (;;) {
    const owner = readOwner();
    if (!owner && tryTake(scenario)) break;
    if (owner && !ownerIsAlive(owner)) {
      out(`the holder (pid ${owner.pid}, ${owner.scenario}) is gone; taking the lock over`);
      reap(owner);
      continue;
    }
    if (owner) note(`waiting for the run lock: pid ${owner.pid} runs ${owner.scenario} since ${Math.round((Date.now() - owner.since) / 1000)} s ago`);
    if (Date.now() - t0 > maxWaitMs) throw new Error(`the run lock was not released within ${Math.round(maxWaitMs / 60_000)} minutes (held by pid ${owner?.pid})`);
    await sleep(1000);
  }
  held = true;
  // A signal ends the process through process.exit (cdp.mjs closes its apps first), and exit releases.
  process.on('exit', release);
  if (exclusive) {
    for (;;) {
      const others = otherOfficeApps(processTable(), null);
      if (!others.length) break;
      note(`holding the lock, waiting for ${others.length} other Online Office app(s) to quit: ${others.map((p) => `pid ${p.pid}`).join(', ')} (they started without the lock)`);
      if (Date.now() - t0 > maxWaitMs) {
        release();
        throw new Error(`other Online Office apps kept running: ${others.map((p) => `${p.pid} ${p.command.slice(-80)}`).join('; ')}`);
      }
      await sleep(2000);
    }
  }
  const waited = Math.round((Date.now() - t0) / 1000);
  out(`took the run lock for ${scenario}${waited > 1 ? ` after waiting ${waited} s` : ''}`);
}
