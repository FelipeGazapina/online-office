// Proof that work exists on disk. A done reply to a work request names artifacts, and each one has to be a path inside the
// block folder (or a commit) that is there and changed since the request was posted. Plain Node, no Electron.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type ArtifactState = 'changed' | 'unchanged' | 'missing';
export type ArtifactPort = {
  // One entry per ref, in order.
  check(who: string, refs: readonly string[], since: number): ArtifactState[];
  // Files the block's folder gained or edited since `since`, for a turn that ended without naming any.
  changed(who: string, since: number): string[];
};

const SHA = /^[0-9a-f]{7,40}$/;
const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', '.next']);
const LIST_CAP = 20;
const WALK_CAP = 5000;

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();

// The newest mtime under a path, so a directory counts as changed when something inside it did.
const newest = (path: string, budget = { left: WALK_CAP }): number => {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let best = st.mtimeMs;
  for (const name of readdirSync(path)) {
    if (SKIP.has(name) || budget.left-- <= 0) continue;
    try {
      best = Math.max(best, newest(join(path, name), budget));
    } catch {
      // vanished while walking
    }
  }
  return best;
};

export const checkRef = (root: string, ref: string, since: number): ArtifactState => {
  if (SHA.test(ref)) {
    try {
      return Number(git(root, ['show', '-s', '--format=%ct', ref])) * 1000 >= since ? 'changed' : 'unchanged';
    } catch {
      return 'missing';
    }
  }
  const abs = resolve(root, ref);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'missing';
  try {
    return newest(abs) >= since ? 'changed' : 'unchanged';
  } catch {
    return 'missing';
  }
};

export const changedFiles = (root: string, since: number): string[] => {
  const out: string[] = [];
  const walk = (dir: string, budget: { left: number }) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || budget.left-- <= 0 || out.length >= LIST_CAP) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) walk(path, budget);
        else if (st.mtimeMs >= since) out.push(relative(root, path));
      } catch {
        // vanished while walking
      }
    }
  };
  walk(root, { left: WALK_CAP });
  return out;
};

export const folderArtifacts = (rootOf: (who: string) => string | undefined): ArtifactPort => ({
  check: (who, refs, since) => {
    const root = rootOf(who);
    return refs.map((r) => (root ? checkRef(root, r, since) : 'missing'));
  },
  changed: (who, since) => {
    const root = rootOf(who);
    return root ? changedFiles(root, since) : [];
  },
});
