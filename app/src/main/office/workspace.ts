// One git worktree and branch per employee, so teammates never write the same folder. The office, not the employee,
// commits and merges: a done request lands on the block's checked-out branch only when the owner's tree is clean.
// Plain Node and real git, no Electron: workspace-check.ts runs it against temp repos.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ArtifactPort, ArtifactState } from './mail-artifacts.ts';

export type Workspace = { path: string; branch: string };

export type Sync = { kind: 'current' } | { kind: 'merged' } | { kind: 'conflict'; paths: string[] } | { kind: 'skipped'; reason: string };

export type Integration =
  | { kind: 'merged'; branch: string }
  | { kind: 'already'; branch: string }
  | { kind: 'held'; branch: string; reason: string }
  | { kind: 'conflict'; branch: string; paths: string[] };

type Out = { ok: boolean; out: string; err: string };

const run = (cwd: string, args: string[], identity?: string, raw = false): Out => {
  const who = identity ? ['-c', `user.name=${identity}`, '-c', `user.email=${slug(identity)}@office.local`, '-c', 'commit.gpgsign=false'] : [];
  const r = spawnSync('git', [...who, ...args], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: raw ? (r.stdout ?? '') : (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

const lines = (s: string) => s.split('\n').filter(Boolean);
const firstLine = (s: string) => lines(s)[0] ?? 'git failed';
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'employee';

// The block folder must be the root of a repo that has a commit. Anything else keeps today's shared folder.
export const isGitRepo = (dir: string): boolean => {
  const top = run(dir, ['rev-parse', '--show-toplevel']);
  return top.ok && real(top.out) === real(dir) && run(dir, ['rev-parse', '--verify', '-q', 'HEAD']).ok;
};

const sameRepo = (a: string, b: string) => {
  const x = run(a, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const y = run(b, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return x.ok && y.ok && real(x.out) === real(y.out);
};

const headOf = (dir: string) => run(dir, ['rev-parse', 'HEAD']).out;
const unmerged = (dir: string) => lines(run(dir, ['diff', '--name-only', '--diff-filter=U']).out);
// Files still in conflict, as the employee would see them: a file is resolved once its markers are gone, with or without `git add`.
const unresolved = (dir: string) =>
  unmerged(dir).filter((f) => {
    try {
      return /^(<{7}|>{7})( |$)/m.test(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return false;
    }
  });
const isAncestor = (dir: string, a: string, b: string) => run(dir, ['merge-base', '--is-ancestor', a, b]).ok;
const dirty = (dir: string, untracked: boolean) => run(dir, ['status', '--porcelain', ...(untracked ? [] : ['--untracked-files=no'])]).out !== '';

// Idempotent: an existing worktree of this repo is reused, anything else at the path is replaced.
export const createWorkspace = (blockCwd: string, path: string, name: string): Workspace => {
  if (existsSync(path)) {
    const branch = run(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.ok && sameRepo(path, blockCwd)) return { path, branch: branch.out };
    rmSync(path, { recursive: true, force: true });
  }
  run(blockCwd, ['worktree', 'prune']);
  const base = `office/${slug(name)}`;
  let branch = base;
  for (let n = 2; run(blockCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok; n++) branch = `${base}-${n}`;
  mkdirSync(dirname(path), { recursive: true });
  const made = run(blockCwd, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (!made.ok) throw new Error(`Could not create ${name}'s worktree: ${firstLine(made.err)}`);
  return { path, branch };
};

const commitAll = (ws: Workspace, name: string, message: string): Out => {
  if (!dirty(ws.path, true)) return { ok: true, out: '', err: '' };
  run(ws.path, ['add', '-A']);
  return run(ws.path, ['commit', '--no-verify', '-m', message], name);
};

// The worktree goes, the branch stays. Work left uncommitted is committed first so firing loses nothing.
export const removeWorkspace = (blockCwd: string, ws: Workspace, name: string): void => {
  if (existsSync(ws.path)) {
    commitAll(ws, name, `Work in progress when ${name} left`);
    run(blockCwd, ['worktree', 'remove', '--force', ws.path]);
    rmSync(ws.path, { recursive: true, force: true });
  }
  run(blockCwd, ['worktree', 'prune']);
};

// Brings the block's current HEAD into the employee's branch before a request starts, or when one reaches them mid-turn. A conflict is left in the
// worktree for the employee to resolve, because the request that follows a failed integration is exactly that.
export const syncWorkspace = (blockCwd: string, ws: Workspace, name: string, midTurn = false): Sync => {
  const stuck = unresolved(ws.path);
  if (stuck.length) return { kind: 'conflict', paths: stuck };
  const head = headOf(blockCwd);
  if (isAncestor(ws.path, head, 'HEAD')) return { kind: 'current' };
  const merged = run(ws.path, ['merge', '--no-edit', '--no-verify', '-m', `Sync ${ws.branch} with the block`, head], name);
  if (merged.ok) return { kind: 'merged' };
  const paths = unmerged(ws.path);
  // Someone in the middle of a turn is not handed a half-open merge: it waits for their next request.
  if (midTurn && paths.length) {
    run(ws.path, ['merge', '--abort']);
    return { kind: 'skipped', reason: `conflicts in ${paths.join(', ')}` };
  }
  return paths.length ? { kind: 'conflict', paths } : { kind: 'skipped', reason: firstLine(merged.err || merged.out) };
};

// Commits what is left in the worktree, then merges the branch into the block's checked-out branch. Re-running after
// a crash converges: a branch the block already contains is a no-op.
export const integrate = (blockCwd: string, ws: Workspace, name: string, title: string): Integration => {
  const { branch } = ws;
  const stuck = unresolved(ws.path);
  if (stuck.length) return { kind: 'conflict', branch, paths: stuck };
  const committed = commitAll(ws, name, title);
  if (!committed.ok) return { kind: 'held', branch, reason: `could not commit ${name}'s changes: ${firstLine(committed.err || committed.out)}` };
  if (isAncestor(blockCwd, branch, 'HEAD')) return { kind: 'already', branch };
  if (dirty(blockCwd, false)) return { kind: 'held', branch, reason: 'the block folder has uncommitted changes, so the office left it alone' };
  const merged = run(blockCwd, ['merge', '--no-ff', '--no-verify', '-m', `Merge ${branch}: ${title}`, branch], name);
  if (merged.ok) return { kind: 'merged', branch };
  const paths = unmerged(blockCwd);
  run(blockCwd, ['merge', '--abort']);
  return paths.length ? { kind: 'conflict', branch, paths } : { kind: 'held', branch, reason: `git could not merge it: ${firstLine(merged.err || merged.out)}` };
};

export const commitsAhead = (blockCwd: string, ws: Workspace): number => Number(run(blockCwd, ['rev-list', '--count', `HEAD..${ws.branch}`]).out) || 0;

// What this employee changed and the block has not absorbed yet: committed work since the merge base, plus whatever is
// uncommitted. It is the employee's own work only, however much the block moved meanwhile.
export const changedInWorkspace = (blockCwd: string, ws: Workspace): string[] => {
  const base = run(ws.path, ['merge-base', 'HEAD', headOf(blockCwd)]);
  const committed = base.ok ? lines(run(ws.path, ['diff', '--name-only', base.out, 'HEAD']).out) : [];
  const status = run(ws.path, ['status', '--porcelain=v1', '-z', '-uall'], undefined, true).out.split('\0').filter(Boolean);
  const uncommitted: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]!;
    uncommitted.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return [...new Set([...committed, ...uncommitted])];
};

const SHA = /^[0-9a-f]{7,40}$/;

export const checkInWorkspace = (blockCwd: string, ws: Workspace, ref: string, changed: readonly string[]): ArtifactState => {
  if (SHA.test(ref)) {
    if (!run(ws.path, ['cat-file', '-e', `${ref}^{commit}`]).ok) return 'missing';
    return isAncestor(ws.path, ref, 'HEAD') && !isAncestor(ws.path, ref, headOf(blockCwd)) ? 'changed' : 'unchanged';
  }
  const abs = resolve(ws.path, ref);
  const rel = relative(ws.path, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'missing';
  if (changed.some((f) => f === rel || f.startsWith(`${rel}/`))) return 'changed';
  return existsSync(abs) ? 'unchanged' : 'missing';
};

// Artifacts for done come from the employee's own branch. A person without a worktree keeps the shared-folder proof.
export const workspaceArtifacts = (of: (who: string) => { blockCwd: string; ws: Workspace } | undefined, shared: ArtifactPort): ArtifactPort => ({
  check: (who, refs, since) => {
    const w = of(who);
    if (!w) return shared.check(who, refs, since);
    const changed = changedInWorkspace(w.blockCwd, w.ws);
    return refs.map((r) => checkInWorkspace(w.blockCwd, w.ws, r, changed));
  },
  changed: (who, since) => {
    const w = of(who);
    return w ? changedInWorkspace(w.blockCwd, w.ws).slice(0, 20) : shared.changed(who, since);
  },
});
