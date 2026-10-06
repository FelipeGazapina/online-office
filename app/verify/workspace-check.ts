// Real git in tiny temp repos, no model, no Electron: per-employee worktrees, integration into the block folder, and the
// mailroom settling on top of them. Run from app/: node verify/workspace-check.ts   Exits 1 on any failed check.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockId, EmployeeId } from '../src/shared/protocol.ts';
import { Mailroom, type Member } from '../src/main/office/mail.ts';
import { folderArtifacts } from '../src/main/office/mail-artifacts.ts';
import { changedInWorkspace, commitsAhead, createWorkspace, integrate, isGitRepo, removeWorkspace, syncWorkspace, workspaceArtifacts, type Workspace } from '../src/main/office/workspace.ts';
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
    artifacts: workspaceArtifacts((who) => (spaces.has(who) ? { blockCwd: block, ws: spaces.get(who)! } : undefined), folderArtifacts(() => block)),
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
