// A branch and a draft pull request per task, end to end with real Claude agents. The block's repo has a local bare repo as
// origin and a fake `gh` is first on PATH, so nothing leaves this machine. A task given straight to an employee gets its
// branch and one draft pull request as work starts, the employee's finished work lands on that branch on origin, and the
// owner's checked-out branch never moves. A task the PO splits between two employees lands both pieces on one branch.
// The fake gh reports a merge and the task moves to done. A restart opens nothing again.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9373 node verify/cdp.mjs verify/e2e-task-pr.mjs
// OFFICE_TASKS_WAIT_MIN caps each run of an agent (default 8).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';
import { installFakeGh } from './fake-gh.ts';

const WAIT_MS = Number(process.env.OFFICE_TASKS_WAIT_MIN ?? 8) * 60_000;

// Prefixed a4- so another worktree's cleanup of office-* scratch folders cannot delete a run in progress.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'a4-pr-')));
const dataDir = join(work, 'data');
const repo = join(work, 'repo');
const bare = join(work, 'origin.git');
mkdirSync(dataDir);
mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
git(work, 'init', '-q', '--bare', '-b', 'main', bare);
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'initial');
git(repo, 'remote', 'add', 'origin', bare);
git(repo, 'push', '-q', '-u', 'origin', 'main');
git(repo, 'remote', 'set-head', 'origin', 'main');
const ownerHead = git(repo, 'rev-parse', 'HEAD');
const gh = installFakeGh(work);

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '5',
  OFFICE_CLAUDE_MODEL: HAIKU,
  OFFICE_PR_POLL_MS: '2000',
  OFFICE_TASK_BOARD_FIXTURE: '',
  PATH: `${gh.bin}${delimiter}${process.env.PATH}`,
};

const ok = (msg) => console.log('ok:', msg);
const state = '__office.store.getState()';
const taskExpr = (id) => `${state}.tasks.find((t) => t.id === ${JSON.stringify(id)})`;
const ledgerFile = join(dataDir, 'company.mail.jsonl');
const ledger = () =>
  existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];
const onOrigin = (branch, file) => {
  try {
    return git(bare, 'show', `${branch}:${file}`);
  } catch {
    return undefined;
  }
};
const ownerUntouched = () => git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(repo, 'rev-parse', 'HEAD') === ownerHead && git(repo, 'status', '--porcelain') === '' && git(bare, 'rev-parse', 'refs/heads/main') === ownerHead;
const creates = () => gh.calls().filter((c) => c[0] === 'pr' && c[1] === 'create');
const taskBranches = () => git(repo, 'branch', '--list', 'task/*', '--format=%(refname:short)').split('\n').filter(Boolean);

// Nobody is at the keyboard, so every employee runs in yolo mode and a permission card raised before the switch is answered.
async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

async function until(s, expr, label, ms = WAIT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await unattended(s);
    if (await s.eval(expr).catch(() => false)) return;
    await s.sleep(1500);
  }
  throw new Error(`${label}: still not true after ${Math.round(ms / 1000)} s: ${expr}`);
}

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('gh calls:', JSON.stringify(gh.calls().map((c) => c.slice(0, 7))));
  console.log('origin branches:', git(bare, 'branch', '--list'));
  console.log('ledger tail:\n' + ledger().filter((e) => e.t === 'post').slice(-12).map((e) => `${e.msg.kind} ${e.msg.from}->${e.msg.to} ${(e.msg.title ?? e.msg.text ?? '').slice(0, 90)}`).join('\n'));
  await s.shot('a4-failure').catch(() => {});
};

export default async (s, { launch }) => {
  try {
    await s.waitFor(`!!${state}.company`);
    await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
    await s.waitFor(`${state}.company.blocks.length === 1`);
    const blockId = await s.eval(`${state}.company.blocks[0].id`);
    for (const [name, role] of [['Pia', 'orchestrator'], ['Ana', 'employee'], ['Bruno', 'employee']]) {
      await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: ${JSON.stringify(name)}${role === 'orchestrator' ? `, role: 'orchestrator'` : ''} })`);
    }
    await s.waitFor(`${state}.company.employees.length === 3`);
    const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
    const who = (name) => people.find((p) => p.name === name).id;
    const quickId = await s.eval(`${state}.boards.find((b) => b.kind === 'quick').id`);

    // ── a task given straight to one employee ──
    const notesOne = 'Write a file named notes.txt in the project folder whose only line is: hello from the task branch. Reply done naming notes.txt.';
    await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Add notes.txt', notes: ${JSON.stringify(notesOne)}, assignee: ${JSON.stringify(who('Ana'))} })`);
    await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add notes.txt')`);
    const one = await s.eval(`${state}.tasks.find((t) => t.title === 'Add notes.txt')`);
    assert(/^task\/add-notes-txt-[0-9a-f]{8}$/.test(one.git?.branch ?? '') && one.git.base === 'main', `assigning a task gives it a branch off main (${one.git?.branch})`);
    assert(git(repo, 'branch', '--list', one.git.branch) !== '' && taskBranches().join() === one.git.branch, 'the branch exists in the block\'s repo');
    await s.waitFor(`!!${taskExpr(one.id)}.git.pr`, 30000);
    const first = await s.eval(taskExpr(one.id));
    assert(first.stage === 'doing' && first.git.pr.state === 'draft' && first.git.pr.number === 1, `the draft pull request exists while the task is still in doing: #${first.git.pr.number} ${first.git.pr.url}`);
    const create = gh.log().find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    assert(creates().length === 1 && ['--draft', '--base', 'main', '--head', one.git.branch, '--title', 'Add notes.txt'].every((a) => create.args.includes(a)), `the office ran gh pr create --draft --base main --head ${one.git.branch} once`);
    assert(git(bare, 'rev-parse', `refs/heads/${one.git.branch}`) !== '', 'the branch was on origin when the pull request opened');
    assert(gh.prs()[0].body.includes('Ana') && gh.prs()[0].body.includes('hello from the task branch'), 'the pull request body names the person and carries the notes');

    await until(s, `${taskExpr(one.id)}.stage === 'review'`, 'notes.txt');
    await until(s, `!${state}.taskTime[${JSON.stringify(one.id)}]?.running.length`, 'turn end', 90_000);
    const t0 = Date.now();
    while (onOrigin(one.git.branch, 'notes.txt') === undefined && Date.now() - t0 < 30_000) await s.sleep(500);
    assert(onOrigin(one.git.branch, 'notes.txt')?.trim() === 'hello from the task branch', 'the employee\'s file is a commit on the task branch on origin');
    const signers = [...new Set(git(bare, 'log', '--format=%an <%ae>', `main..${one.git.branch}`).split('\n').filter(Boolean))];
    assert(signers.join() === 'Fake Owner <owner@fake.example>', `every commit on the branch is signed by the account gh is signed in to (${signers.join(', ')})`);
    assert(git(bare, 'log', '--format=%(trailers:key=Co-authored-by,valueonly)', one.git.branch).includes('Ana <ana@office.local>'), 'and credits the employee who did the work');
    assert(ownerUntouched() && !existsSync(join(repo, 'notes.txt')), 'the owner\'s checked-out branch, folder and origin\'s main are untouched');
    const settled = ledger().find((e) => e.t === 'post' && e.msg.kind === 'reply' && e.msg.requestId === one.runs[0]);
    assert(settled && create.at < settled.msg.at, `the pull request opened ${Math.round((settled.msg.at - create.at) / 1000)} s before the employee's run settled`);
    assert(creates().length === 1, 'still one pull request');

    // The card and the detail show the pull request.
    await s.resize(1440, 900);
    await s.eval(`${state.replace('.getState()', '')}.setState({ modal: { kind: 'task_board', blockId: ${JSON.stringify(blockId)}, taskId: ${JSON.stringify(one.id)} } })`);
    await s.waitFor(`!!document.querySelector('[data-testid=task-detail] [data-testid=task-pr-link]')`);
    const ui = await s.eval(`(() => ({ card: document.querySelector('.tb-card[data-task-id=${JSON.stringify(one.id)}] [data-testid=card-pr]')?.href, cardState: document.querySelector('.tb-card[data-task-id=${JSON.stringify(one.id)}] [data-testid=card-pr]')?.dataset.prState, detail: document.querySelector('[data-testid=task-pr-link]')?.href, state: document.querySelector('[data-testid=task-pr-state]')?.textContent, branch: document.querySelector('[data-testid=task-branch]')?.textContent }))()`);
    assert(ui.card === first.git.pr.url && ui.detail === first.git.pr.url && ui.cardState === 'draft' && ui.state === 'Draft' && ui.branch === one.git.branch, `the card and the detail show the link, the state and the branch (${JSON.stringify(ui)})`);
    await s.sleep(400);
    const shot = await s.shot('a4-pr');
    if (process.env.A4_SHOT_DIR) {
      mkdirSync(process.env.A4_SHOT_DIR, { recursive: true });
      copyFileSync(shot, join(process.env.A4_SHOT_DIR, 'pr.png'));
    }

    // ── the owner merges it on GitHub ──
    gh.setState(first.git.pr.number, 'MERGED');
    await until(s, `${taskExpr(one.id)}.stage === 'done' && ${taskExpr(one.id)}.git.pr.state === 'merged'`, 'merged', 30_000);
    assert(await s.eval(`document.querySelector('.tb-card[data-task-id=${JSON.stringify(one.id)}] [data-testid=card-pr]')?.dataset.prState === 'merged'`), 'the fake gh reported merged: the task moved to Done and its card says Merged');

    // ── a PO splits a task between two employees ──
    await s.eval(`${state.replace('.getState()', '')}.setState({ modal: null })`);
    const notesTwo = 'Send two plain requests, not a gauntlet, and do not hire anyone: ask Ana to write a file a.txt in the project folder whose only line is: from ana. Ask Bruno to write a file b.txt in the project folder whose only line is: from bruno. When both reply done, check both files exist and reply done to the owner naming a.txt and b.txt.';
    await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Add a.txt and b.txt', notes: ${JSON.stringify(notesTwo)}, assignee: ${JSON.stringify(who('Pia'))} })`);
    await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add a.txt and b.txt')`);
    const two = await s.eval(`${state}.tasks.find((t) => t.title === 'Add a.txt and b.txt')`);
    assert(two.git.branch !== one.git.branch && taskBranches().length === 2, 'the second task has a branch of its own');
    await until(s, `${taskExpr(two.id)}.stage === 'review'`, 'a.txt and b.txt');
    await until(s, `!${state}.taskTime[${JSON.stringify(two.id)}]?.running.length`, 'turn end', 90_000);
    const t1 = Date.now();
    while ((onOrigin(two.git.branch, 'a.txt') === undefined || onOrigin(two.git.branch, 'b.txt') === undefined) && Date.now() - t1 < 30_000) await s.sleep(500);
    assert(onOrigin(two.git.branch, 'a.txt')?.trim() === 'from ana' && onOrigin(two.git.branch, 'b.txt')?.trim() === 'from bruno', 'both pieces are on the same task branch on origin');
    const credits = git(bare, 'log', '--format=%(trailers:key=Co-authored-by,valueonly)', two.git.branch);
    const twoSigners = [...new Set(git(bare, 'log', '--format=%an', `main..${two.git.branch}`).split('\n').filter(Boolean))];
    assert(credits.includes('Ana <ana@office.local>') && credits.includes('Bruno <bruno@office.local>') && twoSigners.join() === 'Fake Owner', 'the account signs every commit and each piece credits the person who did it');
    assert(onOrigin(two.git.branch, 'notes.txt') === undefined && onOrigin(one.git.branch, 'a.txt') === undefined, 'neither task carries the other\'s files');
    const delegated = ledger().filter((e) => e.t === 'post' && e.msg.kind === 'request' && e.msg.rootId === two.runs[0] && e.msg.id !== two.runs[0]).map((e) => e.msg.to);
    assert(delegated.includes(who('Ana')) && delegated.includes(who('Bruno')), 'the pieces really went through the PO to both employees');
    assert(creates().length === 2 && gh.prs().length === 2 && (await s.eval(`${taskExpr(two.id)}.git.pr.number`)) === 2, 'one pull request per task');
    assert(ownerUntouched() && !existsSync(join(repo, 'a.txt')) && !existsSync(join(repo, 'b.txt')), 'the owner\'s branch is untouched after both tasks');

    // ── restart ──
    const before = await s.eval(`${state}.tasks.map((t) => ({ id: t.id, stage: t.stage, git: t.git }))`);
    const createsBefore = creates().length;
    const viewsBefore = gh.calls().filter((c) => c[1] === 'view').length;
    const originBefore = git(bare, 'branch', '--list');
    await s.close();
    const again = await launch({ env });
    await again.waitFor('!!window.__office && !!window.office');
    await again.waitFor(`${state}.company.employees.length === 3 && ${state}.tasks.length === ${before.length}`, 30000);
    await again.sleep(6000);
    const after = await again.eval(`${state}.tasks.map((t) => ({ id: t.id, stage: t.stage, git: t.git }))`);
    assert(JSON.stringify(after) === JSON.stringify(before), 'every task keeps its stage, branch and pull request across a restart');
    assert(creates().length === createsBefore && gh.prs().length === 2 && taskBranches().length === 2 && git(bare, 'branch', '--list') === originBefore, 'a restart opens no new pull request and makes no new branch');
    assert(gh.calls().filter((c) => c[1] === 'view').length > viewsBefore, 'it did ask GitHub where the open pull request stands');
    assert(ownerUntouched(), 'and the owner\'s branch is still where it was');
  } finally {
    // The driver prints its diagnosis first, which reads these folders.
    process.on('exit', () => rmSync(work, { recursive: true, force: true }));
  }
};
