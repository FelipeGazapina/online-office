// One git worktree and branch per employee, so teammates never write the same folder. The office, not the employee,
// commits and merges. A done request lands in a "home": the block's checked-out branch (only when the owner's tree is
// clean) or, for work that belongs to a task, the task's own branch in its own worktree. Every function that takes a
// `home` takes either one and treats it the same way.
// Plain Node and real git, no Electron: workspace-check.ts runs it against temp repos.
import { spawn, spawnSync } from 'node:child_process';
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

export type CommitAuthor = { name: string; email: string };

// Who signs the commits the office makes: the GitHub account gh is signed in to, set by the office. CI that checks a
// commit's author against the repo's people (Vercel does) refuses anyone else, so the employee who did the work is
// credited in a Co-authored-by trailer instead. Without it the repo's own git identity signs, and only a repo with none
// falls back to the employee's name.
let signer: CommitAuthor | null = null;
export const setCommitAuthor = (author: CommitAuthor | null): void => {
  signer = author;
};

const OFFICE_NAME = 'Online Office';
const employeeEmail = (name: string) => `${slug(name)}@office.local`;
const hasGitIdentity = (cwd: string) => spawnSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8' }).stdout?.trim() !== '';

// The -c flags and the message for a commit or merge made on `doer`'s behalf.
const signed = (cwd: string, args: string[], doer?: string): string[] => {
  if (!doer) return args;
  const author = signer ?? (hasGitIdentity(cwd) ? null : { name: doer, email: employeeEmail(doer) });
  const who = [...(author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : []), '-c', 'commit.gpgsign=false'];
  const credited = author?.name !== doer && doer !== OFFICE_NAME;
  const m = args.indexOf('-m');
  if (!credited || m < 0) return [...who, ...args];
  return [...who, ...args.slice(0, m + 1), `${args[m + 1]}\n\nCo-authored-by: ${doer} <${employeeEmail(doer)}>`, ...args.slice(m + 2)];
};

const run = (cwd: string, args: string[], identity?: string, raw = false): Out => {
  const r = spawnSync('git', signed(cwd, args, identity), { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: raw ? (r.stdout ?? '') : (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

const lines = (s: string) => s.split('\n').filter(Boolean);
// The line that says what went wrong: git prints progress before it.
const firstLine = (s: string) => lines(s).find((l) => /^(fatal|error):/.test(l)) ?? lines(s)[0] ?? 'git failed';
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

// Whether another branch already has everything this one has. Then the branch holds no work of its own, and what it
// holds can be dropped from the worktree without losing a commit.
const delivered = (ws: Workspace): boolean =>
  lines(run(ws.path, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']).out).some((ref) => ref !== `refs/heads/${ws.branch}`);

// Brings the home's current HEAD into the employee's branch before a request starts, or when one reaches them mid-turn. A conflict is left in the
// worktree for the employee to resolve, because the request that follows a failed integration is exactly that.
// A branch that already delivered its work somewhere else (another task's branch, the block) starts over from the home instead of
// merging, so one task's commits never ride into another task's pull request.
export const syncWorkspace = (home: string, ws: Workspace, name: string, midTurn = false): Sync => {
  const stuck = unresolved(ws.path);
  if (stuck.length) return { kind: 'conflict', paths: stuck };
  const head = headOf(home);
  if (!midTurn && !isAncestor(ws.path, 'HEAD', head) && !dirty(ws.path, true) && delivered(ws) && run(ws.path, ['reset', '--hard', '-q', head]).ok) return { kind: 'merged' };
  if (isAncestor(ws.path, head, 'HEAD')) return { kind: 'current' };
  const merged = run(ws.path, ['merge', '--no-edit', '--no-verify', '-m', `Sync ${ws.branch} with the latest work`, head], name);
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
export const integrate = (home: string, ws: Workspace, name: string, title: string): Integration => {
  const { branch } = ws;
  const stuck = unresolved(ws.path);
  if (stuck.length) return { kind: 'conflict', branch, paths: stuck };
  const committed = commitAll(ws, name, title);
  if (!committed.ok) return { kind: 'held', branch, reason: `could not commit ${name}'s changes: ${firstLine(committed.err || committed.out)}` };
  if (isAncestor(home, branch, 'HEAD')) return { kind: 'already', branch };
  if (dirty(home, false)) return { kind: 'held', branch, reason: 'the block folder has uncommitted changes, so the office left it alone' };
  const merged = run(home, ['merge', '--no-ff', '--no-verify', '-m', `Merge ${branch}: ${title}`, branch], name);
  if (merged.ok) return { kind: 'merged', branch };
  const paths = unmerged(home);
  run(home, ['merge', '--abort']);
  return paths.length ? { kind: 'conflict', branch, paths } : { kind: 'held', branch, reason: `git could not merge it: ${firstLine(merged.err || merged.out)}` };
};

// For work whose home is not there: commits what is left on the employee's branch and lands nowhere.
export const hold = (ws: Workspace, name: string, title: string, reason: string): Integration => {
  const committed = commitAll(ws, name, title);
  return { kind: 'held', branch: ws.branch, reason: committed.ok ? reason : `could not commit ${name}'s changes: ${firstLine(committed.err || committed.out)}` };
};

export const commitsAhead = (home: string, ws: Workspace): number => Number(run(home, ['rev-list', '--count', `HEAD..${ws.branch}`]).out) || 0;

// What this employee changed and the block has not absorbed yet: committed work since the merge base, plus whatever is
// uncommitted. It is the employee's own work only, however much the block moved meanwhile.
export const changedInWorkspace = (home: string, ws: Workspace): string[] => {
  const base = run(ws.path, ['merge-base', 'HEAD', headOf(home)]);
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

export const checkInWorkspace = (home: string, ws: Workspace, ref: string, changed: readonly string[]): ArtifactState => {
  if (SHA.test(ref)) {
    if (!run(ws.path, ['cat-file', '-e', `${ref}^{commit}`]).ok) return 'missing';
    return isAncestor(ws.path, ref, 'HEAD') && !isAncestor(ws.path, ref, headOf(home)) ? 'changed' : 'unchanged';
  }
  const abs = resolve(ws.path, ref);
  const rel = relative(ws.path, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'missing';
  if (changed.some((f) => f === rel || f.startsWith(`${rel}/`))) return 'changed';
  return existsSync(abs) ? 'unchanged' : 'missing';
};

// Artifacts for done come from the employee's own branch. A person without a worktree keeps the shared-folder proof.
export const workspaceArtifacts = (of: (who: string) => { home: string; ws: Workspace } | undefined, shared: ArtifactPort): ArtifactPort => ({
  check: (who, refs, since) => {
    const w = of(who);
    if (!w) return shared.check(who, refs, since);
    const changed = changedInWorkspace(w.home, w.ws);
    return refs.map((r) => checkInWorkspace(w.home, w.ws, r, changed));
  },
  changed: (who, since) => {
    const w = of(who);
    return w ? changedInWorkspace(w.home, w.ws).slice(0, 20) : shared.changed(who, since);
  },
});

// ───────────────────────────── a task's own branch ─────────────────────────────

// Where a task's branch starts and which branch its pull request targets. `ref` is something any worktree of the repo
// resolves; `origin` says whether the repo has a remote to push to.
export type Base = { name: string; ref: string; origin: boolean };

const exists = (dir: string, ref: string) => run(dir, ['show-ref', '--verify', '--quiet', ref]).ok;

// The default branch of the block's repo: what origin's HEAD points at when there is a remote that has it, else the branch the owner has checked out.
export const defaultBase = (blockCwd: string): Base => {
  const origin = run(blockCwd, ['remote', 'get-url', 'origin']).ok;
  if (origin) {
    const head = run(blockCwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const name = head.ok ? head.out.replace(/^origin\//, '') : ['main', 'master'].find((n) => exists(blockCwd, `refs/remotes/origin/${n}`));
    if (name && exists(blockCwd, `refs/remotes/origin/${name}`)) return { name, ref: `refs/remotes/origin/${name}`, origin };
  }
  const branch = run(blockCwd, ['symbolic-ref', '--quiet', 'HEAD']);
  return branch.ok ? { name: branch.out.replace(/^refs\/heads\//, ''), ref: branch.out, origin } : { name: 'HEAD', ref: headOf(blockCwd), origin };
};

export type TaskBranch = { branch: string; title: string; key: string };

// Idempotent. The branch is found by `key` (the short id every task branch name ends with), so a task whose title changed since still
// gets its own branch back. A worktree that is already on it is reused, and a branch with no commit of its own gets the one a pull request needs.
export const createTaskWorkspace = (blockCwd: string, path: string, task: TaskBranch, base: Base): Workspace => {
  run(blockCwd, ['worktree', 'prune']);
  const branch = lines(run(blockCwd, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/*-${task.key}`]).out)[0] ?? task.branch;
  const have = exists(blockCwd, `refs/heads/${branch}`);
  const there = existsSync(path) && run(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!(there && there.ok && there.out === branch && sameRepo(path, blockCwd))) {
    rmSync(path, { recursive: true, force: true });
    run(blockCwd, ['worktree', 'prune']);
    mkdirSync(dirname(path), { recursive: true });
    // A branch this repo only knows from origin (the block moved to another clone) continues from there, not from the base.
    const sent = `refs/remotes/origin/${branch}`;
    const made = run(blockCwd, ['worktree', 'add', ...(have ? [path, branch] : ['-b', branch, path, exists(blockCwd, sent) ? sent : base.ref])]);
    if (!made.ok) throw new Error(`Could not make the worktree of ${branch}: ${firstLine(made.err)}`);
  }
  const ws = { path, branch };
  // GitHub does not open a pull request for a branch that has nothing the base lacks.
  if (!(Number(run(path, ['rev-list', '--count', `${base.ref}..HEAD`]).out) > 0)) run(path, ['commit', '--allow-empty', '--no-verify', '-m', `Start: ${task.title}`], OFFICE_NAME);
  return ws;
};

// The worktree goes, the branch stays: it may be the head of a pull request.
export const removeTaskWorkspace = (blockCwd: string | undefined, path: string): void => {
  if (blockCwd && existsSync(path)) run(blockCwd, ['worktree', 'remove', '--force', path]);
  rmSync(path, { recursive: true, force: true });
  if (blockCwd) run(blockCwd, ['worktree', 'prune']);
};

export type Pushed = { kind: 'pushed' } | { kind: 'no-remote' } | { kind: 'failed'; reason: string };

// Never waits on git in the main process: network time belongs to the event loop. A prompt for credentials is refused, not waited on.
const runAsync = (cwd: string, args: string[], timeoutMs: number, identity?: string): Promise<Out> =>
  new Promise((done) => {
    const child = spawn('git', signed(cwd, args, identity), { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, out: '', err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });

// Pushes the task's branch to origin. When origin has moved on (the owner pressed "Update branch" on GitHub) it merges that in first. The branch is
// the office's own, so nothing is ever forced.
export const pushBranch = async (path: string, branch: string, name = OFFICE_NAME): Promise<Pushed> => {
  if (!run(path, ['remote', 'get-url', 'origin']).ok) return { kind: 'no-remote' };
  const push = () => runAsync(path, ['push', '--set-upstream', 'origin', `${branch}:${branch}`], 120_000);
  let pushed = await push();
  if (!pushed.ok && /rejected|non-fast-forward|fetch first/i.test(pushed.err)) {
    const fetched = await runAsync(path, ['fetch', 'origin', branch], 120_000);
    const merged = fetched.ok && (await runAsync(path, ['merge', '--no-edit', '--no-verify', `origin/${branch}`], 60_000, name));
    if (merged && merged.ok) pushed = await push();
    else if (unmerged(path).length) run(path, ['merge', '--abort']);
  }
  return pushed.ok ? { kind: 'pushed' } : { kind: 'failed', reason: firstLine(pushed.err || pushed.out) };
};

// Commits the last push did not carry: a branch never pushed, or one that moved since. Reads the remote-tracking ref this
// repo already has, so it asks no one.
export const unpushed = (path: string, branch: string): boolean => {
  if (!run(path, ['remote', 'get-url', 'origin']).ok) return false;
  if (!exists(path, `refs/remotes/origin/${branch}`)) return true;
  return Number(run(path, ['rev-list', '--count', `refs/remotes/origin/${branch}..${branch}`]).out) > 0;
};
