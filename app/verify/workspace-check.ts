// Real git in tiny temp repos, no model, no Electron: per-employee worktrees, integration into the block folder, and the
// mailroom settling on top of them. Run from app/: node verify/workspace-check.ts   Exits 1 on any failed check.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockId, EmployeeId } from '../src/shared/protocol.ts';
import { Mailroom, type Member } from '../src/main/office/mail.ts';
import { folderArtifacts } from '../src/main/office/mail-artifacts.ts';
import { changedInWorkspace, commitsAhead, createTaskWorkspace, createWorkspace, defaultBase, integrate, isGitRepo, pushBranch, removeTaskWorkspace, removeWorkspace, syncWorkspace, workspaceArtifacts, type Base, type Workspace } from '../src/main/office/workspace.ts';
import { check, finish } from './check.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-check-')));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};
let seq = 0;
const repo = (): string => {
  const dir = join(root, `block${++seq}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'shared.txt', 'line 1\nline 2\nline 3\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
};
const hire = (block: string, name: string): Workspace => createWorkspace(block, join(root, 'data', `${name}-${seq}`), name);
const log = (dir: string) => git(dir, 'log', '--format=%s', '--first-parent');
const unmergedNone = (dir: string) => git(dir, 'diff', '--name-only', '--diff-filter=U') === '' && !existsSync(join(dir, git(dir, 'rev-parse', '--git-path', 'MERGE_HEAD')));
const text = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

// hire
{
  const block = repo();
  const ana = hire(block, 'Ana');
  check(ana.branch === 'office/ana' && existsSync(join(ana.path, 'shared.txt')), 'hire creates a worktree with the block files on branch office/<name>');
  check(git(ana.path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'office/ana', 'the worktree has its branch checked out');
  check(git(block, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(block, 'status', '--porcelain') === '', 'the block folder stays on its branch and stays clean');
  check(createWorkspace(block, ana.path, 'Ana').branch === 'office/ana', 'creating a workspace that already exists reuses it');
  const twin = createWorkspace(block, join(root, 'data', 'twin'), 'Ana');
  check(twin.branch === 'office/ana-2', 'a second Ana gets her own branch instead of sharing');
}

// non-git block
{
  const plain = join(root, 'plain');
  mkdirSync(plain);
  check(!isGitRepo(plain), 'a folder that is not a git repo falls back to the shared folder');
  const empty = join(root, 'empty');
  mkdirSync(empty);
  git(empty, 'init', '-q');
  check(!isGitRepo(empty), 'a repo with no commit falls back too');
  check(isGitRepo(repo()), 'a repo root with a commit counts as git');
  const nested = repo();
  mkdirSync(join(nested, 'pkg'));
  check(!isGitRepo(join(nested, 'pkg')), 'a folder inside a repo, not its root, falls back');
}

// two employees, one file, in parallel
{
  const block = repo();
  const ana = hire(block, 'Ana');
  const bruno = hire(block, 'Bruno');
  write(ana.path, 'shared.txt', 'line 1\nANA\nline 3\n');
  write(ana.path, 'ana.txt', 'ana only\n');
  write(bruno.path, 'shared.txt', 'line 1\nBRUNO\nline 3\n');
  write(bruno.path, 'bruno.txt', 'bruno only\n');
  check(changedInWorkspace(block, ana).sort().join() === 'ana.txt,shared.txt', 'artifacts are Ana\'s own files, not Bruno\'s concurrent edits');
  check(changedInWorkspace(block, bruno).sort().join() === 'bruno.txt,shared.txt', 'and Bruno\'s are his');
  const first = integrate(block, ana, 'Ana', 'Ana edits shared');
  check(first.kind === 'merged' && text(block, 'shared.txt').includes('ANA') && git(block, 'log', '-1', '--format=%an', ana.branch) === 'Ana', 'the first integration merges, authored by the employee');
  check(/Merge office\/ana/.test(log(block)), 'the block log shows the employee merge');
  const second = integrate(block, bruno, 'Bruno', 'Bruno edits shared');
  check(second.kind === 'conflict' && second.paths.join() === 'shared.txt', 'the second integration reports the conflict instead of overwriting', JSON.stringify(second));
  check(text(block, 'shared.txt').includes('ANA') && !text(block, 'shared.txt').includes('BRUNO') && git(block, 'status', '--porcelain') === '' && !existsSync(join(block, '.git', 'MERGE_HEAD')), 'the block keeps Ana\'s version, clean, with no merge left open');
  check(!existsSync(join(block, 'bruno.txt')), 'nothing of the conflicting branch leaked into the block');
  const sync = syncWorkspace(block, bruno, 'Bruno');
  check(sync.kind === 'conflict' && sync.paths.join() === 'shared.txt', 'syncing the block into Bruno leaves the conflict in his worktree to resolve');
  check(integrate(block, bruno, 'Bruno', 'again').kind === 'conflict', 'integrating before he resolves is refused again');
  write(bruno.path, 'shared.txt', 'line 1\nANA\nBRUNO\nline 3\n');
  const resolved = integrate(block, bruno, 'Bruno', 'Bruno resolves');
  check(resolved.kind === 'merged' && text(block, 'shared.txt').includes('BRUNO') && existsSync(join(block, 'bruno.txt')) && existsSync(join(block, 'ana.txt')), 'after he resolves, both pieces are in the block');
  const before = git(block, 'rev-parse', 'HEAD');
  check(integrate(block, bruno, 'Bruno', 'rerun').kind === 'already' && git(block, 'rev-parse', 'HEAD') === before, 'rerunning an integration changes nothing');
  check(commitsAhead(block, bruno) === 0 && changedInWorkspace(block, bruno).length === 0, 'after integration the branch is not ahead and has no pending files');
}

// a request that reaches someone mid-turn
{
  const block = repo();
  const ana = hire(block, 'Ana');
  const bruno = hire(block, 'Bruno');
  write(ana.path, 'lib.txt', 'ana lib\n');
  integrate(block, ana, 'Ana', 'Ana lib');
  write(bruno.path, 'draft.txt', 'bruno is typing\n');
  const mid = syncWorkspace(block, bruno, 'Bruno', true);
  check(mid.kind === 'merged' && text(bruno.path, 'lib.txt') === 'ana lib\n' && text(bruno.path, 'draft.txt') === 'bruno is typing\n', 'a mid-turn sync brings in teammates\' integrated files and keeps the uncommitted draft');
  write(ana.path, 'shared.txt', 'ANA\n');
  integrate(block, ana, 'Ana', 'Ana shared');
  write(bruno.path, 'shared.txt', 'BRUNO\n');
  const clash = syncWorkspace(block, bruno, 'Bruno', true);
  check(clash.kind === 'skipped' && text(bruno.path, 'shared.txt') === 'BRUNO\n' && unmergedNone(bruno.path), 'a mid-turn sync that would clash is skipped and leaves no merge open');
}

// the owner's dirty tree
{
  const block = repo();
  const ana = hire(block, 'Ana');
  write(ana.path, 'new.txt', 'new\n');
  write(block, 'shared.txt', 'owner is typing\n');
  const held = integrate(block, ana, 'Ana', 'Ana adds new');
  check(held.kind === 'held' && held.branch === 'office/ana', 'an owner with uncommitted changes holds the integration');
  check(text(block, 'shared.txt') === 'owner is typing\n' && !existsSync(join(block, 'new.txt')), 'the owner\'s folder is untouched');
  check(git(block, 'show', 'office/ana:new.txt') === 'new', 'the result waits, committed, on the employee branch');
  git(block, 'checkout', '-q', '--', 'shared.txt');
  check(integrate(block, ana, 'Ana', 'Ana adds new').kind === 'merged' && existsSync(join(block, 'new.txt')), 'once the owner is clean, the same integration goes through');
}

// the default branch a task starts from
const bare = (): { origin: string; block: string } => {
  const origin = join(root, `origin${++seq}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const block = repo();
  git(block, 'remote', 'add', 'origin', origin);
  git(block, 'push', '-q', '-u', 'origin', 'main');
  return { origin, block };
};
{
  const plain = repo();
  git(plain, 'checkout', '-q', '-b', 'wip');
  const local = defaultBase(plain);
  check(local.name === 'wip' && !local.origin && git(plain, 'rev-parse', local.ref) === git(plain, 'rev-parse', 'HEAD'), 'with no remote a task starts from the branch the owner has checked out', JSON.stringify(local));
  const { block } = bare();
  const fetched = defaultBase(block);
  check(fetched.name === 'main' && fetched.origin && fetched.ref === 'refs/remotes/origin/main', 'with a remote it starts from origin\'s main even before origin/HEAD is set', JSON.stringify(fetched));
  git(block, 'checkout', '-q', '-b', 'owner-wip');
  git(block, 'remote', 'set-head', 'origin', 'main');
  check(defaultBase(block).name === 'main' && defaultBase(block).ref === 'refs/remotes/origin/main', 'origin/HEAD decides, whatever branch the owner has checked out');
  const lonely = repo();
  git(lonely, 'remote', 'add', 'origin', join(root, 'nowhere.git'));
  check(defaultBase(lonely).name === 'main' && defaultBase(lonely).origin && defaultBase(lonely).ref === 'refs/heads/main', 'a remote that has no default branch yet falls back to the checked-out branch');
}

// a task branch: naming, reuse, and what it keeps out of the owner's folder
{
  const { block, origin } = bare();
  const base = defaultBase(block);
  const path = join(root, 'data', `task-${seq}`);
  const want = { branch: 'task/fix-login-1a2b3c4d', title: 'Fix login', key: '1a2b3c4d' };
  const ownerHead = git(block, 'rev-parse', 'HEAD');
  const ws = createTaskWorkspace(block, path, want, base);
  check(ws.branch === want.branch && git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD') === want.branch, 'the task gets its branch in its own worktree');
  check(git(ws.path, 'rev-list', '--count', `${base.ref}..HEAD`) === '1' && git(ws.path, 'log', '-1', '--format=%s') === 'Start: Fix login' && git(ws.path, 'diff', '--name-only', base.ref, 'HEAD') === '', 'the branch starts one empty commit ahead of the base, so a pull request can open');
  check(git(block, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(block, 'rev-parse', 'HEAD') === ownerHead && git(block, 'status', '--porcelain') === '', 'the owner\'s checked-out branch and folder are untouched');
  const tip = git(ws.path, 'rev-parse', 'HEAD');
  const again = createTaskWorkspace(block, path, want, base);
  check(again.branch === ws.branch && git(ws.path, 'rev-parse', 'HEAD') === tip && git(block, 'branch', '--list', 'task/*').split('\n').length === 1, 'making it again reuses the branch and adds no commit');
  removeTaskWorkspace(block, path);
  check(!existsSync(path) && git(block, 'branch', '--list', want.branch) !== '' && !git(block, 'worktree', 'list').includes(want.branch), 'removing the worktree keeps the branch');
  const back = createTaskWorkspace(block, path, { ...want, branch: 'task/another-title-1a2b3c4d', title: 'Another title' }, base);
  check(back.branch === want.branch && git(back.path, 'rev-parse', 'HEAD') === tip && git(block, 'branch', '--list', 'task/*').split('\n').length === 1, 'a worktree the owner deleted comes back on the same commits, found by the task\'s id even after its title changed');
  const other = createTaskWorkspace(block, join(root, 'data', `task-b-${seq}`), { branch: 'task/other-99999999', title: 'Other', key: '99999999' }, base);
  check(other.branch === 'task/other-99999999' && git(other.path, 'rev-parse', 'HEAD') !== tip, 'a second task gets a second branch');

  const pushed = await pushBranch(ws.path, ws.branch);
  check(pushed.kind === 'pushed' && git(origin, 'rev-parse', `refs/heads/${want.branch}`) === tip, 'the branch is pushed to origin', JSON.stringify(pushed));
  check((await pushBranch(ws.path, ws.branch)).kind === 'pushed' && git(origin, 'rev-parse', `refs/heads/${want.branch}`) === tip, 'pushing again changes nothing');
  const clone = join(root, `clone${seq}`);
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', want.branch);
  write(clone, 'from-github.txt', 'edited on GitHub\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'Update branch');
  git(clone, 'push', '-q', 'origin', want.branch);
  write(ws.path, 'ours.txt', 'ours\n');
  git(ws.path, 'add', '-A');
  git(ws.path, 'commit', '-q', '-m', 'our work');
  const behind = await pushBranch(ws.path, ws.branch);
  check(behind.kind === 'pushed' && existsSync(join(ws.path, 'from-github.txt')) && git(origin, 'rev-parse', `refs/heads/${want.branch}`) === git(ws.path, 'rev-parse', 'HEAD'), 'when origin moved on, its commits are merged in and the push goes through, never forced', JSON.stringify(behind));
  const offline = repo();
  const lone = createTaskWorkspace(offline, join(root, 'data', `task-c-${seq}`), { branch: 'task/solo-aaaaaaaa', title: 'Solo', key: 'aaaaaaaa' }, defaultBase(offline));
  check((await pushBranch(lone.path, lone.branch)).kind === 'no-remote' && git(offline, 'rev-parse', '--verify', `refs/heads/${lone.branch}`) !== '', 'with no remote there is nothing to push and the branch stays local');
  const gone = repo();
  git(gone, 'remote', 'add', 'origin', join(root, 'nowhere.git'));
  const lost = createTaskWorkspace(gone, join(root, 'data', `task-d-${seq}`), { branch: 'task/lost-bbbbbbbb', title: 'Lost', key: 'bbbbbbbb' }, defaultBase(gone));
  const refused = await pushBranch(lost.path, lost.branch);
  check(refused.kind === 'failed' && refused.reason.length > 0, 'a remote that cannot be reached is reported, not thrown', JSON.stringify(refused));
}

// pieces of a task land on its branch, not on the owner's
{
  const { block, origin } = bare();
  const base = defaultBase(block);
  const task = createTaskWorkspace(block, join(root, 'data', `task-p-${seq}`), { branch: 'task/two-pieces-cccccccc', title: 'Two pieces', key: 'cccccccc' }, base);
  const ana = hire(block, 'Ana');
  const bruno = hire(block, 'Bruno');
  const ownerHead = git(block, 'rev-parse', 'HEAD');
  check(syncWorkspace(task.path, ana, 'Ana').kind === 'merged' && syncWorkspace(task.path, bruno, 'Bruno').kind === 'merged', 'each person starts from the task branch');
  check(git(ana.path, 'log', '-1', '--format=%s') === 'Start: Two pieces', 'and so has the task\'s first commit');
  write(ana.path, 'ana.txt', 'ana piece\n');
  write(bruno.path, 'bruno.txt', 'bruno piece\n');
  check(changedInWorkspace(task.path, ana).join() === 'ana.txt' && changedInWorkspace(task.path, bruno).join() === 'bruno.txt', 'artifacts are measured against the task branch, so a teammate\'s file is not mine');
  const first = integrate(task.path, ana, 'Ana', 'Ana\'s piece');
  const second = integrate(task.path, bruno, 'Bruno', 'Bruno\'s piece');
  check(first.kind === 'merged' && second.kind === 'merged' && existsSync(join(task.path, 'ana.txt')) && existsSync(join(task.path, 'bruno.txt')), 'both pieces land on the same task branch');
  check(git(block, 'rev-parse', 'HEAD') === ownerHead && git(block, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && !existsSync(join(block, 'ana.txt')) && git(block, 'status', '--porcelain') === '', 'the owner\'s checked-out branch is untouched');
  check(git(task.path, 'log', '--format=%an', '-n', '6', '--no-merges').includes('Ana') && /Merge office\/ana/.test(log(task.path)), 'the task log shows the employees\' commits and merges');
  check((await pushBranch(task.path, task.branch)).kind === 'pushed' && git(origin, 'show', `${task.branch}:ana.txt`) === 'ana piece' && git(origin, 'show', `${task.branch}:bruno.txt`) === 'bruno piece', 'origin has both pieces on the task branch and nothing on main');
  check(git(origin, 'rev-parse', 'refs/heads/main') === ownerHead, 'origin\'s main did not move');
  check(integrate(task.path, ana, 'Ana', 'again').kind === 'already', 'rerunning an integration into the task changes nothing');
  check(commitsAhead(task.path, ana) === 0, 'after the merge her branch is not ahead of the task');
}

// a conflict between two pieces of one task is handled as it is for the block
{
  const { block } = bare();
  const task = createTaskWorkspace(block, join(root, 'data', `task-q-${seq}`), { branch: 'task/clash-dddddddd', title: 'Clash', key: 'dddddddd' }, defaultBase(block));
  const ana = hire(block, 'Ana');
  const bruno = hire(block, 'Bruno');
  syncWorkspace(task.path, ana, 'Ana');
  syncWorkspace(task.path, bruno, 'Bruno');
  write(ana.path, 'shared.txt', 'line 1\nANA\nline 3\n');
  write(bruno.path, 'shared.txt', 'line 1\nBRUNO\nline 3\n');
  integrate(task.path, ana, 'Ana', 'Ana edits');
  const clash = integrate(task.path, bruno, 'Bruno', 'Bruno edits');
  check(clash.kind === 'conflict' && clash.paths.join() === 'shared.txt' && git(task.path, 'status', '--porcelain') === '' && !existsSync(join(task.path, '.git', 'MERGE_HEAD')) && text(task.path, 'shared.txt').includes('ANA'), 'the second piece reports the conflict and the task branch stays clean with the first piece in it');
  const sync = syncWorkspace(task.path, bruno, 'Bruno');
  check(sync.kind === 'conflict' && sync.paths.join() === 'shared.txt', 'syncing the task branch into Bruno leaves the conflict in his worktree');
  write(bruno.path, 'shared.txt', 'line 1\nANA\nBRUNO\nline 3\n');
  check(integrate(task.path, bruno, 'Bruno', 'Bruno resolves').kind === 'merged' && text(task.path, 'shared.txt').includes('BRUNO'), 'once he resolves, his piece lands on the task branch');
}

// one task's commits do not ride into another task, or into the block
{
  const { block } = bare();
  const base = defaultBase(block);
  const a = createTaskWorkspace(block, join(root, 'data', `task-a-${seq}`), { branch: 'task/first-eeeeeeee', title: 'First', key: 'eeeeeeee' }, base);
  const b = createTaskWorkspace(block, join(root, 'data', `task-b2-${seq}`), { branch: 'task/second-ffffffff', title: 'Second', key: 'ffffffff' }, base);
  const ana = hire(block, 'Ana');
  syncWorkspace(a.path, ana, 'Ana');
  write(ana.path, 'for-first.txt', 'first\n');
  check(integrate(a.path, ana, 'Ana', 'First piece').kind === 'merged', 'Ana finishes a piece of the first task');
  const moved = syncWorkspace(b.path, ana, 'Ana');
  check(moved.kind === 'merged' && !existsSync(join(ana.path, 'for-first.txt')) && git(ana.path, 'rev-parse', 'HEAD') === git(b.path, 'rev-parse', 'HEAD'), 'starting the second task, her branch starts over from it instead of carrying the first task along', JSON.stringify(moved));
  write(ana.path, 'for-second.txt', 'second\n');
  integrate(b.path, ana, 'Ana', 'Second piece');
  check(!existsSync(join(b.path, 'for-first.txt')) && existsSync(join(b.path, 'for-second.txt')) && existsSync(join(a.path, 'for-first.txt')) && !existsSync(join(a.path, 'for-second.txt')), 'each task branch holds only its own work');
  check(git(ana.path, 'branch', '--contains', git(a.path, 'rev-parse', 'HEAD')).includes(a.branch), 'the first task\'s work is still safe on its own branch');
  const back = syncWorkspace(block, ana, 'Ana');
  write(ana.path, 'plain.txt', 'no task\n');
  check(back.kind === 'merged' && !existsSync(join(ana.path, 'for-second.txt')) && integrate(block, ana, 'Ana', 'No task').kind === 'merged' && !existsSync(join(block, 'for-second.txt')) && !existsSync(join(block, 'for-first.txt')) && existsSync(join(block, 'plain.txt')), 'work outside any task still goes to the block, without the tasks\' commits');
  // work that exists nowhere else is never dropped to make room
  const bruno = hire(block, 'Bruno');
  write(bruno.path, 'only-here.txt', 'sole copy\n');
  integrate(a.path, bruno, 'Bruno', 'held').kind;
  const dirtyTask = createTaskWorkspace(block, join(root, 'data', `task-g-${seq}`), { branch: 'task/third-12121212', title: 'Third', key: '12121212' }, base);
  write(dirtyTask.path, 'task-only.txt', 'x\n');
  git(dirtyTask.path, 'add', '-A');
  git(dirtyTask.path, 'commit', '-q', '-m', 'task side');
  const keep = hire(block, 'Cleo');
  write(keep.path, 'cleo.txt', 'cleo only\n');
  git(keep.path, 'add', '-A');
  git(keep.path, 'commit', '-q', '-m', 'cleo unintegrated');
  const merged = syncWorkspace(dirtyTask.path, keep, 'Cleo');
  check(merged.kind === 'merged' && existsSync(join(keep.path, 'cleo.txt')) && existsSync(join(keep.path, 'task-only.txt')), 'a branch holding work no one else has is merged, never reset');
  const dirt = hire(block, 'Dina');
  write(dirt.path, 'dina.txt', 'dina\n');
  git(dirt.path, 'add', '-A');
  git(dirt.path, 'commit', '-q', '-m', 'dina delivered');
  git(block, 'merge', '-q', '--no-edit', dirt.branch);
  write(dirt.path, 'draft.txt', 'uncommitted\n');
  const kept = syncWorkspace(dirtyTask.path, dirt, 'Dina');
  check(kept.kind === 'merged' && existsSync(join(dirt.path, 'draft.txt')), 'uncommitted files are never wiped by the start-over either');
}

// fire
{
  const block = repo();
  const ana = hire(block, 'Ana');
  write(ana.path, 'draft.txt', 'half done\n');
  removeWorkspace(block, ana, 'Ana');
  check(!existsSync(ana.path), 'firing removes the worktree');
  check(git(block, 'branch', '--list', 'office/ana') !== '' && git(block, 'show', 'office/ana:draft.txt') === 'half done', 'the branch stays, with unfinished work committed');
  check(!git(block, 'worktree', 'list').includes('office/ana'), 'git no longer lists the worktree');
  removeWorkspace(block, ana, 'Ana');
  check(true, 'removing twice is harmless');
}

// the mailroom on top of real worktrees
{
  const block = repo();
  const ana = hire(block, 'Ana');
  const bruno = hire(block, 'Bruno');
  const spaces = new Map<string, Workspace>([['ana', ana], ['bruno', bruno]]);
  const members: Member[] = [
    { id: 'po' as EmployeeId, name: 'Pia', role: 'orchestrator', blockId: 'b1' as BlockId, status: 'idle' },
    { id: 'ana' as EmployeeId, name: 'Ana', role: 'employee', blockId: 'b1' as BlockId, status: 'idle' },
    { id: 'bruno' as EmployeeId, name: 'Bruno', role: 'employee', blockId: 'b1' as BlockId, status: 'idle' },
  ];
  const prompts = new Map<string, string[]>();
  const names = new Map(members.map((m) => [m.id, m.name]));
  let n = 0;
  const room = new Mailroom({
    members: () => members,
    nameOf: (a) => (a === 'owner' ? 'the owner' : (names.get(a as EmployeeId) ?? a)),
    deliver: (to, prompt) => void prompts.set(to, [...(prompts.get(to) ?? []), prompt]),
    steer: () => {},
    hire: () => ({ ok: false, reason: 'no' }),
    artifacts: workspaceArtifacts((who) => (spaces.has(who) ? { home: block, ws: spaces.get(who)! } : undefined), folderArtifacts(() => block)),
    integrate: (who, title) => integrate(block, spaces.get(who)!, names.get(who)!, title),
    branchOf: (who) => (spaces.has(who) ? { branch: spaces.get(who)!.branch, ahead: commitsAhead(block, spaces.get(who)!) } : undefined),
    persist: () => {},
    changed: () => {},
    stream: () => {},
    now: () => 1_000 + n,
    newId: () => `m${String(++n).padStart(4, '0')}`,
  });
  const requestIn = (who: string) => /\[Request (\w+) /.exec(prompts.get(who)!.at(-1)!)![1]!;
  const send = (to: string, body: string) => {
    const r = room.post({ from: 'owner', to, blockId: 'b1' as BlockId, body: { kind: 'request', text: body } });
    if (!r.ok) throw new Error(r.reason);
    return r.id;
  };
  const outcome = (id: string) => {
    const l = room.state.life.get(id as never);
    const r = l?.s === 'settled' ? room.state.messages.get(l.by) : undefined;
    return r?.kind === 'reply' ? r : undefined;
  };

  const a = send('ana', 'edit shared');
  const b = send('bruno', 'edit shared too');
  write(ana.path, 'shared.txt', 'line 1\nANA\nline 3\n');
  write(bruno.path, 'shared.txt', 'line 1\nBRUNO\nline 3\n');
  write(bruno.path, 'b.txt', 'b\n');
  const refused = room.reply('ana' as EmployeeId, requestIn('ana'), { outcome: 'done', text: 'done', artifact: ['b.txt'] });
  check(!refused.ok && refused.reason === 'artifact_missing', 'a file Ana did not make in her own worktree is not her artifact');
  const ok = room.reply('ana' as EmployeeId, requestIn('ana'), { outcome: 'done', text: 'edited', artifact: ['shared.txt'] });
  const doneA = outcome(a);
  check(ok.ok && doneA?.outcome === 'done' && /Integrated: office\/ana/.test(doneA.text) && text(block, 'shared.txt').includes('ANA'), 'Ana settles done and her branch lands in the block');
  const conflicted = room.reply('bruno' as EmployeeId, requestIn('bruno'), { outcome: 'done', text: 'edited', artifact: ['shared.txt', 'b.txt'] });
  const blockedB = outcome(b);
  check(conflicted.ok && blockedB?.outcome === 'blocked' && /shared\.txt/.test(blockedB.text), 'Bruno\'s conflicting done settles blocked and names the conflicting path');
  const followUp = [...room.state.unsettled].map((id) => room.state.messages.get(id)!).find((m) => m.kind === 'request' && m.to === 'bruno');
  check(followUp?.kind === 'request' && followUp.from === 'owner' && /Resolve the merge/.test(followUp.title), 'the same employee gets a new request to merge the block into his branch');
  check(text(block, 'shared.txt').includes('ANA') && !text(block, 'shared.txt').includes('BRUNO'), 'the block was not overwritten');
  const team = room.team('ana' as EmployeeId);
  check(team.find((t) => t.name === 'Bruno')?.branch === 'office/bruno' && team.find((t) => t.name === 'Bruno')?.ahead === 1, 'the team view lists each person\'s branch and commits ahead of the block', JSON.stringify(team));
}

finish();
