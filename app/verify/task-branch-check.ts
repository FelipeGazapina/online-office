// No model, no Electron. A branch and a draft pull request per task: the naming and pull request rules, the gh wrapper against
// an in-memory gh, and the real Office on a scripted harness with real git, a local bare repo as origin and a fake `gh` on PATH.
// Nothing here touches a real remote. Run from app/: node verify/task-branch-check.ts   Exits 1 on any failed check.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { BlockId, EmployeeId } from '../src/shared/protocol.ts';
import { newTask, prBody, prIsOpen, runRequest, taskBranchName, taskKey, withGitNote, withPr, type Board, type BoardId, type Task, type TaskId, type TaskPr } from '../src/shared/tasks.ts';
import { ensurePr, readPr, whyNot, type Gh, type GhRun } from '../src/main/office/pull-request.ts';
import { check, finish, sleep, until } from './check.ts';
import { installFakeGh } from './fake-gh.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-branch-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const task = (s: string) => s as TaskId;
const board = { id: 'b' as BoardId, blockId: 'blk' as BlockId, name: 'Quick tasks', kind: 'quick' } as Board;

console.log('# branch names, pull request text, and what a pull request does to a task');
{
  const id = '1A2B3C4D-aaaa-bbbb-cccc-dddddddddddd';
  check(taskKey(id) === '1a2b3c4d' && taskKey('---') === 'task', 'a task\'s key is the first eight letters and digits of its id');
  check(taskBranchName('Fix the login bug', id) === 'task/fix-the-login-bug-1a2b3c4d', 'a branch is task/<slug>-<key>');
  check(taskBranchName('  Ünïcode & "quotes" ??? ', id) === 'task/n-code-quotes-1a2b3c4d', 'anything that is not a letter or digit becomes one dash', taskBranchName('  Ünïcode & "quotes" ??? ', id));
  check(taskBranchName('!!!', id) === 'task/task-1a2b3c4d', 'a title with nothing to slug still gets a name');
  const long = taskBranchName('Make the checkout page respond faster on slow phones and tablets', id);
  check(long.length <= 'task/'.length + 32 + 9 && long.endsWith('-1a2b3c4d') && !long.includes('--'), 'a long title is cut, never in the middle of a dash', long);
  check(taskBranchName('Same title', id) === taskBranchName('Same title', id) && taskBranchName('Same title', id) !== taskBranchName('Same title', 'ffffffff-0000'), 'same title, same id: the same branch; another task, another branch');

  const base = newTask({ id: task(id), boardId: board.id, title: 'Add CSV export', notes: 'with tests', origin: { kind: 'manual' }, stage: 'todo', now: 1 });
  const linear = newTask({ id: task('t2'), boardId: board.id, title: 'Linear one', origin: { kind: 'linear', externalId: 'x', identifier: 'ENG-12', url: 'https://linear.app/x/ENG-12', providerStatus: 'Todo', sourceLabel: 'Linear' }, stage: 'todo', now: 1 });
  const body = prBody(base, ['Ana', 'Pia']);
  check(body.startsWith('with tests') && body.includes('**People:** Ana, Pia') && !body.includes('**From'), 'the pull request says the notes and the people');
  check(prBody(linear, ['Ana']).includes('**From Linear:** [ENG-12](https://linear.app/x/ENG-12)'), 'a Linear task links its identifier');
  check(prBody({ ...base, notes: undefined }, []).startsWith('Opened by Online Office'), 'a task with no notes and nobody on it still gets a sentence');

  check(!runRequest(base, board).text.includes('git branch'), 'a task with no branch asks for nothing about git');
  const branched: Task = { ...base, git: { branch: 'task/add-csv-export-1a2b3c4d', base: 'main' } };
  check(runRequest(branched, board).text.includes('task/add-csv-export-1a2b3c4d') && runRequest(branched, board).text.includes('Task board: Quick tasks.'), 'the request names the branch the work lands on');

  const pr = (state: TaskPr['state']): TaskPr => ({ number: 7, url: 'https://github.com/o/r/pull/7', state });
  const drafted = withPr(branched, pr('draft'), 5);
  check(drafted.git?.pr?.state === 'draft' && drafted.stage === 'todo' && withPr(drafted, pr('draft'), 9) === drafted, 'recording a pull request changes nothing it already knew');
  const merged = withPr({ ...drafted, stage: 'doing' }, pr('merged'), 6);
  check(merged.stage === 'done' && merged.git?.pr?.state === 'merged' && !prIsOpen(merged.git.pr), 'a merged pull request moves the task to done');
  const lastMove = merged.history?.at(-1);
  check(lastMove?.kind === 'stage' && lastMove.from === 'doing' && lastMove.to === 'done' && lastMove.by === 'owner' && lastMove.at === 6, 'and the move is on the task\'s history, as the owner\'s');
  const closed = withPr({ ...drafted, stage: 'review' }, pr('closed'), 6);
  check(closed.stage === 'review' && closed.git?.pr?.state === 'closed' && !prIsOpen(closed.git.pr), 'a closed one is only shown');
  check(prIsOpen(pr('draft')) && prIsOpen(pr('open')) && !prIsOpen(undefined), 'draft and open are the open ones');
  const noted = withGitNote(branched, 'no remote', 3);
  check(noted.git?.note === 'no remote' && withGitNote(noted, 'no remote', 4) === noted && withGitNote(noted, undefined, 4).git?.note === undefined && withPr(noted, pr('draft'), 5).git?.note === undefined, 'a note stays until it is cleared, and a pull request clears it');
  check(withPr(base, pr('merged'), 5) === base && withGitNote(base, 'x', 5) === base, 'a task with no branch is left alone');
}

console.log('\n# the gh wrapper');
{
  const prs: { number: number; url: string; state: string; isDraft: boolean }[] = [];
  const calls: string[][] = [];
  let failWith: GhRun | undefined;
  let raceOnce = false;
  const gh: Gh = async (_cwd, args) => {
    calls.push(args);
    if (failWith) return failWith;
    if (args[1] === 'list') return { ok: true, out: JSON.stringify(prs), err: '' };
    if (args[1] === 'view') {
      const found = prs.find((p) => String(p.number) === args[2]);
      return found ? { ok: true, out: JSON.stringify(found), err: '' } : { ok: false, out: '', err: 'Could not resolve to a PullRequest' };
    }
    if (raceOnce) {
      raceOnce = false;
      prs.push({ number: 9, url: 'https://github.com/o/r/pull/9', state: 'OPEN', isDraft: true });
      return { ok: false, out: '', err: 'a pull request already exists' };
    }
    prs.push({ number: prs.length + 1, url: `https://github.com/o/r/pull/${prs.length + 1}`, state: 'OPEN', isDraft: args.includes('--draft') });
    return { ok: true, out: `https://github.com/o/r/pull/${prs.length}\n`, err: '' };
  };
  const spec = { branch: 'task/x-1', base: 'main', title: 'X', body: 'b' };
  const first = await ensurePr(gh, dir, spec);
  const create = calls.find((c) => c[1] === 'create')!;
  check(first.kind === 'pr' && first.pr.number === 1 && first.pr.state === 'draft', 'a branch with no pull request gets a draft one', JSON.stringify(first));
  check(create.join(' ') === 'pr create --draft --base main --head task/x-1 --title X --body b', 'and it is opened as a draft against the base', create.join(' '));
  const again = await ensurePr(gh, dir, spec);
  check(again.kind === 'pr' && again.pr.number === 1 && calls.filter((c) => c[1] === 'create').length === 1, 'asking again finds it and opens no second');
  prs.push({ number: 5, url: 'https://github.com/o/r/pull/5', state: 'MERGED', isDraft: false }, { number: 6, url: 'https://github.com/o/r/pull/6', state: 'OPEN', isDraft: false });
  const open = await ensurePr(gh, dir, spec);
  check(open.kind === 'pr' && open.pr.number === 6 && open.pr.state === 'open', 'an open pull request wins over an older one that is merged');
  prs.length = 0;
  raceOnce = true;
  const raced = await ensurePr(gh, dir, spec);
  check(raced.kind === 'pr' && raced.pr.number === 9, 'a pull request someone opened a moment before is found, not reported as a failure');
  const viewed = await readPr(gh, dir, 9);
  check(viewed.kind === 'pr' && viewed.pr.state === 'draft', 'reading a pull request maps GitHub\'s words onto draft, open, merged, closed');
  prs.push({ number: 10, url: 'https://github.com/o/r/pull/10', state: 'MERGED', isDraft: false }, { number: 11, url: 'https://github.com/o/r/pull/11', state: 'CLOSED', isDraft: false });
  const states = await Promise.all([10, 11].map((n) => readPr(gh, dir, n)));
  check(states.map((s) => (s.kind === 'pr' ? s.pr.state : s.note)).join() === 'merged,closed', 'merged and closed are read as they are');
  check((await readPr(gh, dir, 404)).kind === 'none', 'a pull request that is gone is a note, not a throw');

  const words = (r: GhRun) => whyNot(r);
  check(/not installed/.test(words({ ok: false, out: '', err: 'spawn gh ENOENT', missing: true })), 'a missing gh says how to get it');
  check(/not signed in/.test(words({ ok: false, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' })), 'a gh that is signed out says to sign in');
  check(/no GitHub remote/.test(words({ ok: false, out: '', err: 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`' })), 'a repo with no GitHub remote is told apart from a signed-out gh');
  failWith = { ok: false, out: '', err: 'pull request create failed: GraphQL: No commits between main and x' };
  const refused = await ensurePr(gh, dir, spec);
  check(refused.kind === 'none' && /No commits between main and x/.test(refused.note), 'anything else is GitHub\'s own sentence');
}

console.log('\n# the office, with real git, a bare origin and a fake gh');
{
  const fake = installFakeGh(dir);
  process.env.PATH = `${fake.bin}${delimiter}${process.env.PATH}`;
  process.env.OFFICE_START_LEVEL = '5';
  process.env.OFFICE_PR_POLL_MS = '200';
  delete process.env.OFFICE_CLAUDE_MODEL;
  // The office reads PATH and the poll period when it loads, so it loads now.
  const { Office } = await import('../src/main/office/company.ts');
  const { HARNESSES } = await import('../src/main/office/adapters/index.ts');
  const { startOfficeMcp } = await import('../src/main/office/mcp.ts');
  const { MemoryStore } = await import('../src/main/office/memory.ts');
  const { TaskBoardService } = await import('../src/main/office/task-board.ts');
  type SessionHost = import('../src/main/office/adapters/types.ts').SessionHost;
  type Mailroom = import('../src/main/office/mail.ts').Mailroom;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (cwd: string, file: string, text: string) => {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  let seq = 0;
  const makeRepo = (origin: boolean) => {
    const repo = join(dir, `repo${++seq}`);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    write(repo, 'README.md', '# scratch\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    if (!origin) return { repo, bare: '' };
    const bare = join(dir, `origin${seq}.git`);
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    return { repo, bare };
  };
  const onOrigin = (bare: string, branch: string, file: string) => {
    try {
      return git(bare, 'show', `${branch}:${file}`);
    } catch {
      return undefined;
    }
  };
  const branchesIn = (repo: string) => git(repo, 'branch', '--list', 'task/*', '--format=%(refname:short)').split('\n').filter(Boolean);

  const memory = MemoryStore.open(join(dir, 'memory'));
  const mcp = await startOfficeMcp();
  const acker = { warm() {}, ack: () => undefined, stop() {} };
  type Fake = { host: SessionHost; assigned: string[] };
  const fakes: Fake[] = [];
  HARNESSES['claude-code'] = {
    ...HARNESSES['claude-code'],
    session: (host) => {
      const f: Fake = { host, assigned: [] };
      fakes.push(f);
      return {
        assign: (text, title) => {
          f.assigned.push(text);
          host.setStatus({ kind: 'working', task: title ?? text, startedAt: Date.now() });
        },
        interject() {},
        setModel() {},
        permissionsChanged() {},
        rulesChanged() {},
        stop() {},
      };
    },
  };
  const live = (name: string) => fakes.filter((f) => f.host.employee.name === name).at(-1)!;
  const finishTurn = async (f: Fake, text = 'done') => {
    f.host.taskCompleted(text);
    f.host.setStatus({ kind: 'idle' });
    await sleep(60);
  };
  class Provider extends TaskBoardService {
    override async fetchSources() {
      return { cards: [], errors: [] };
    }
  }
  const harnesses = { 'claude-code': { kind: 'ready' as const, version: 'fake' }, codex: { kind: 'missing' as const }, hermes: { kind: 'missing' as const } };
  const errors: string[] = [];
  const open = (file: string) => new Office(file, harnesses, { building() {}, rejected() {}, changed() {}, said() {}, log() {}, error: (m) => void errors.push(m) }, { mcp, memory, acker, taskBoards: new Provider() });

  const { repo, bare } = makeRepo(true);
  const local = makeRepo(false).repo;
  const folder = join(dir, 'plain-folder');
  mkdirSync(folder);
  const file = join(dir, 'company.json');
  let office = open(file);
  office.handle({ type: 'create_block', cwd: repo });
  office.handle({ type: 'create_block', cwd: local });
  office.handle({ type: 'create_block', cwd: folder });
  const snap = () => office.snapshot();
  const [blockA, blockB, blockC] = snap().company.blocks.map((b) => b.id) as [BlockId, BlockId, BlockId];
  const quick = (b: BlockId) => snap().boards.find((x) => x.blockId === b && x.kind === 'quick')!.id;
  for (const [blockId, name, role] of [[blockA, 'Pia', 'orchestrator'], [blockA, 'Ana', 'employee'], [blockA, 'Bruno', 'employee'], [blockB, 'Dot', 'employee'], [blockC, 'Eve', 'employee']] as const) {
    office.handle({ type: 'hire', provider: 'claude-code', blockId, name, ...(role === 'orchestrator' ? { role } : {}) });
  }
  const id = (name: string) => snap().company.employees.find((e) => e.name === name)!.id as EmployeeId;
  const theTask = (title: string) => snap().tasks.find((t) => t.title === title)!;
  const ownerHead = git(repo, 'rev-parse', 'HEAD');
  const ownerUntouched = () => git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(repo, 'rev-parse', 'HEAD') === ownerHead && git(repo, 'status', '--porcelain') === '';
  const prCalls = (what: 'create' | 'list' | 'view') => fake.calls().filter((c) => c[0] === 'pr' && c[1] === what);

  console.log('\n## one employee, one task');
  office.handle({ type: 'create_task', boardId: quick(blockA), title: 'Write the docs', notes: 'Short and plain', assignee: id('Ana') });
  const docs = theTask('Write the docs');
  const worktree = (t: Task) => join(dir, 'worktrees', `task-${t.id}`);
  check(!!docs.git && /^task\/write-the-docs-[0-9a-f]{8}$/.test(docs.git.branch) && docs.git.base === 'main', 'assigning a task gives it a branch off main', JSON.stringify(docs.git));
  check(branchesIn(repo).join() === docs.git!.branch && existsSync(worktree(docs)) && git(worktree(docs), 'rev-parse', '--abbrev-ref', 'HEAD') === docs.git!.branch, 'the branch exists in the block\'s repo, in its own worktree');
  check(live('Ana').assigned.length === 1 && live('Ana').assigned[0]!.includes(docs.git!.branch), 'and Ana is told which branch her work lands on', live('Ana').assigned[0]);
  check(git(live('Ana').host.block.cwd, 'log', '-1', '--format=%s') === 'Start: Write the docs' && git(live('Ana').host.block.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') === 'office/ana', 'she starts in her own worktree, from the task branch');
  check(ownerUntouched(), 'the owner\'s checked-out branch and folder are untouched');
  check(await until(() => !!theTask('Write the docs').git?.pr, 15000), 'a pull request shows up on the task', JSON.stringify([theTask('Write the docs').git, fake.calls()]));
  const withPrDocs = theTask('Write the docs');
  check(withPrDocs.git!.pr!.number === 1 && withPrDocs.git!.pr!.state === 'draft' && withPrDocs.git!.pr!.url === 'https://github.com/fake-owner/fake-repo/pull/1' && !withPrDocs.git!.note, 'it is a draft with a link', JSON.stringify(withPrDocs.git));
  const created = prCalls('create');
  check(created.length === 1 && created[0]!.join(' ').startsWith(`pr create --draft --base main --head ${docs.git!.branch} --title Write the docs --body`), 'the office ran gh pr create --draft once, for this branch', created.map((c) => c.slice(0, 9).join(' ')).join(' | '));
  const prBodyText = fake.prs()[0]!.body;
  check(prBodyText.includes('Short and plain') && prBodyText.includes('Ana'), 'the pull request carries the notes and the person', prBodyText);
  check(git(bare, 'rev-parse', `refs/heads/${docs.git!.branch}`) !== '' && git(bare, 'rev-list', '--count', `main..${docs.git!.branch}`) === '1', 'the branch is on origin, one commit ahead of main');

  write(live('Ana').host.block.cwd, 'docs.md', 'Short and plain\n');
  await finishTurn(live('Ana'), 'docs written');
  check(theTask('Write the docs').stage === 'review' && theTask('Write the docs').lastOutcome?.outcome === 'done', 'her turn ends and the task moves to review');
  check(await until(() => onOrigin(bare, docs.git!.branch, 'docs.md') === 'Short and plain', 15000), 'her finished work is a commit on the task branch on origin');
  check(git(bare, 'log', '--format=%an', docs.git!.branch).split('\n').includes('Ana'), 'with her as the author');
  check(!existsSync(join(repo, 'docs.md')) && ownerUntouched() && git(bare, 'rev-parse', 'refs/heads/main') === ownerHead, 'nothing reached the owner\'s branch, here or on origin');
  check(prCalls('create').length === 1, 'and there is still one pull request');

  console.log('\n## a PO delegates to two employees');
  office.handle({ type: 'create_task', boardId: quick(blockA), title: 'Ship the report', notes: 'two parts', assignee: id('Pia') });
  const report = theTask('Ship the report');
  check(report.git!.branch !== docs.git!.branch && branchesIn(repo).length === 2, 'a second task gets its own branch');
  const mail = (office as unknown as { mail: Mailroom }).mail;
  for (const [who, title] of [['Ana', 'Part one'], ['Bruno', 'Part two']] as const) {
    const sent = mail.post({ from: id('Pia'), to: id(who), blockId: blockA, body: { kind: 'request', intent: 'work', title, text: title } });
    check(sent.ok, `the PO sends ${who} ${title}`);
  }
  check(git(live('Ana').host.block.cwd, 'log', '-1', '--format=%s') === 'Start: Ship the report' && !existsSync(join(live('Ana').host.block.cwd, 'docs.md')), 'Ana, who finished the first task, starts the second from its branch without the first task\'s files');
  write(live('Ana').host.block.cwd, 'part-one.txt', 'one\n');
  write(live('Bruno').host.block.cwd, 'part-two.txt', 'two\n');
  await finishTurn(live('Ana'), 'part one done');
  await finishTurn(live('Bruno'), 'part two done');
  check(await until(() => onOrigin(bare, report.git!.branch, 'part-one.txt') === 'one' && onOrigin(bare, report.git!.branch, 'part-two.txt') === 'two', 15000), 'both pieces land on the one task branch on origin');
  check(onOrigin(bare, report.git!.branch, 'docs.md') === undefined && onOrigin(bare, docs.git!.branch, 'part-one.txt') === undefined, 'and neither task carries the other\'s work');
  await finishTurn(live('Pia'), 'report shipped');
  check(theTask('Ship the report').stage === 'review' && theTask('Ship the report').lastOutcome?.outcome === 'done', 'the PO\'s own run settles done once her pieces are in');
  check(await until(() => !!theTask('Ship the report').git?.pr, 15000) && prCalls('create').length === 2 && fake.prs().map((p) => p.number).join() === '1,2', 'each task has exactly one pull request');
  check(ownerUntouched() && !existsSync(join(repo, 'part-one.txt')), 'the owner\'s branch is still untouched');
  const bothAuthors = git(bare, 'log', '--format=%an', report.git!.branch).split('\n');
  check(bothAuthors.includes('Ana') && bothAuthors.includes('Bruno'), 'the commits are authored by the people who did the pieces');

  console.log('\n## the same work twice, and a restart');
  const created2 = prCalls('create').length;
  office.handle({ type: 'assign_task', taskId: docs.id, employeeId: id('Ana') });
  check(theTask('Write the docs').runs.length === 2 && branchesIn(repo).length === 2 && theTask('Write the docs').git!.branch === docs.git!.branch, 'assigning again posts another run and makes no second branch');
  office.handle({ type: 'assign_task', taskId: docs.id, employeeId: id('Ana') });
  check(theTask('Write the docs').runs.length === 2, 'asking while she is on it posts nothing');
  write(live('Ana').host.block.cwd, 'docs2.md', 'more\n');
  await finishTurn(live('Ana'), 'more docs');
  check(await until(() => onOrigin(bare, docs.git!.branch, 'docs2.md') === 'more', 15000) && prCalls('create').length === created2, 'the second run lands on the same branch and opens no second pull request');
  const before = JSON.stringify(snap().tasks.map((t) => [t.id, t.git]));
  const tipOnOrigin = git(bare, 'rev-parse', `refs/heads/${docs.git!.branch}`);
  office.shutdown();
  office = open(file);
  await sleep(600);
  check(JSON.stringify(snap().tasks.map((t) => [t.id, t.git])) === before && prCalls('create').length === created2 && branchesIn(repo).length === 2, 'a restart makes no new branch and no new pull request, and the tasks keep what they had');
  check(git(bare, 'rev-parse', `refs/heads/${docs.git!.branch}`) === tipOnOrigin, 'and pushes nothing new');
  rmSync(worktree(docs), { recursive: true, force: true });
  const tipBefore = git(repo, 'rev-parse', docs.git!.branch);
  office.handle({ type: 'assign_task', taskId: docs.id, employeeId: id('Bruno') });
  check(existsSync(worktree(docs)) && git(worktree(docs), 'rev-parse', 'HEAD') === tipBefore && branchesIn(repo).length === 2, 'a worktree the owner deleted comes back on the same commits when someone is given the task');
  await finishTurn(live('Bruno'), 'nothing to add');

  console.log('\n## the owner checks the task branch out in the block folder');
  office.handle({ type: 'create_task', boardId: quick(blockA), title: 'Owner looks', assignee: id('Bruno') });
  const looked = theTask('Owner looks');
  write(live('Bruno').host.block.cwd, 'looked.txt', 'first\n');
  await finishTurn(live('Bruno'), 'first look');
  check(await until(() => onOrigin(bare, looked.git!.branch, 'looked.txt') === 'first', 15000), 'a task\'s first run lands on its branch');
  rmSync(worktree(looked), { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
  git(repo, 'checkout', '-q', looked.git!.branch);
  const ownerTip = git(repo, 'rev-parse', 'HEAD');
  office.handle({ type: 'assign_task', taskId: looked.id, employeeId: id('Ana') });
  check(/already (checked out|used by worktree)/.test(theTask('Owner looks').git!.note ?? ''), 'git cannot make a second worktree of a branch the owner has open, and the task says so', theTask('Owner looks').git!.note);
  write(live('Ana').host.block.cwd, 'held.txt', 'held\n');
  await finishTurn(live('Ana'), 'held work');
  const heldReply = [...(office as unknown as { mail: Mailroom }).mail.state.messages.values()].filter((m) => m.kind === 'reply' && m.from === id('Ana')).at(-1);
  check(heldReply?.kind === 'reply' && /Not integrated/.test(heldReply.text), 'her work is not merged anywhere, and her reply says so', heldReply && 'text' in heldReply ? heldReply.text : '');
  check(git(repo, 'rev-parse', 'HEAD') === ownerTip && git(repo, 'status', '--porcelain') === '' && !existsSync(join(repo, 'held.txt')), 'the folder the owner has open is not touched');
  check(git(repo, 'show', 'office/ana:held.txt') === 'held', 'the work is safe, committed on her own branch');
  git(repo, 'checkout', '-q', 'main');

  console.log('\n## the owner merges on GitHub');
  fake.markReady(1);
  const stageBefore = theTask('Write the docs').stage;
  check(await until(() => theTask('Write the docs').git?.pr?.state === 'open', 15000) && theTask('Write the docs').stage === stageBefore, 'marking the draft ready for review on GitHub shows the pull request open, and leaves the task where it was');
  fake.setState(1, 'MERGED');
  check(await until(() => theTask('Write the docs').git?.pr?.state === 'merged', 15000), 'the pull request shows merged on the next check');
  check(theTask('Write the docs').stage === 'done', 'and the task moves to done');
  check(!existsSync(worktree(docs)) && branchesIn(repo).includes(docs.git!.branch), 'its worktree is let go and its branch stays');
  fake.setState(2, 'CLOSED');
  check(await until(() => theTask('Ship the report').git?.pr?.state === 'closed', 15000) && theTask('Ship the report').stage === 'review', 'a closed pull request is shown closed and the task stays where it was');
  fake.setState(3, 'MERGED');
  check(await until(() => theTask('Owner looks').git?.pr?.state === 'merged', 15000) && theTask('Owner looks').stage === 'done', 'a task that was held up by the owner\'s open branch is done when its pull request merges');
  const polled = prCalls('view').length;
  await sleep(700);
  check(prCalls('view').length === polled, 'once nothing is open, nobody asks GitHub again', JSON.stringify([polled, fake.log().filter((c) => c.args[1] === 'view').map((c) => [c.args[2], c.at % 100000]), snap().tasks.map((t) => [t.title, t.git?.pr?.state])]));

  console.log('\n## no remote, no gh login, no git');
  const callsBefore = fake.calls().length;
  office.handle({ type: 'create_task', boardId: quick(blockB), title: 'Local only', assignee: id('Dot') });
  const lonely = theTask('Local only');
  check(!!lonely.git && /^task\/local-only-/.test(lonely.git.branch) && git(local, 'branch', '--list', lonely.git.branch) !== '', 'a block with no remote still gets its branch');
  check(await until(() => !!theTask('Local only').git?.note, 3000) && /no remote called origin/.test(theTask('Local only').git!.note!) && !theTask('Local only').git!.pr, 'the task says why there is no pull request');
  check(fake.calls().length === callsBefore, 'and gh is never run');
  write(live('Dot').host.block.cwd, 'dot.txt', 'dot\n');
  await finishTurn(live('Dot'), 'dot done');
  check(theTask('Local only').stage === 'review' && git(local, 'show', `${lonely.git!.branch}:dot.txt`) === 'dot' && !existsSync(join(local, 'dot.txt')) && git(local, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'her work lands on the local task branch, not on the owner\'s');

  fake.mode('logged-out');
  office.handle({ type: 'create_task', boardId: quick(blockA), title: 'Needs login', assignee: id('Bruno') });
  const login = theTask('Needs login');
  check(await until(() => !!theTask('Needs login').git?.note, 15000) && /not signed in/.test(theTask('Needs login').git!.note!) && !theTask('Needs login').git!.pr, 'with gh signed out the task says to sign in');
  check(git(bare, 'rev-parse', `refs/heads/${login.git!.branch}`) !== '', 'the branch is on origin all the same');
  write(live('Bruno').host.block.cwd, 'login.txt', 'x\n');
  await finishTurn(live('Bruno'), 'login done');
  check(await until(() => onOrigin(bare, login.git!.branch, 'login.txt') === 'x', 15000) && theTask('Needs login').stage === 'review', 'the work still lands and is pushed');
  fake.mode('ok');
  try {
    office.handle({ type: 'refresh_board', boardId: quick(blockA) });
  } catch {
    // a quick board has nothing to pull, and says so after it has asked about pull requests
  }
  check(await until(() => !!theTask('Needs login').git?.pr && !theTask('Needs login').git?.note, 15000), 'refreshing the board opens the pull request once gh works, and clears the note', JSON.stringify([theTask('Needs login').git, fake.state().mode, fake.calls().slice(-6).map((c) => c.slice(0, 4).join(' '))]));
  check(prCalls('create').filter((c) => c.includes(login.git!.branch)).length === 1, 'with one gh pr create for it');

  office.handle({ type: 'create_task', boardId: quick(blockC), title: 'No repo here', assignee: id('Eve') });
  check(!theTask('No repo here').git && live('Eve').assigned.length === 1 && !live('Eve').assigned[0]!.includes('branch'), 'a block that is not a git repository gets no branch and no mention of one');

  console.log('\n## the block moves to another clone of the same origin');
  const moved = join(dir, 'moved-repo');
  git(dir, 'clone', '-q', bare, moved);
  const during = theTask('Needs login');
  for (const e of snap().company.employees.filter((x) => x.status.kind === 'working')) await finishTurn(live(e.name), 'wrapped up');
  office.handle({ type: 'update_block', blockId: blockA, cwd: moved });
  check(!existsSync(worktree(during)) && theTask('Needs login').git!.branch === during.git!.branch && theTask('Needs login').git!.pr?.number === during.git!.pr?.number, 'the old folder\'s task worktrees are let go and the tasks keep their branch and pull request');
  office.handle({ type: 'assign_task', taskId: during.id, employeeId: id('Bruno') });
  check(existsSync(worktree(during)) && existsSync(join(worktree(during), 'login.txt')) && git(moved, 'branch', '--list', during.git!.branch) !== '', 'the next run makes the worktree again in the new folder, from the branch origin already has');
  write(live('Bruno').host.block.cwd, 'again.txt', 'again\n');
  await finishTurn(live('Bruno'), 'again done');
  check(await until(() => onOrigin(bare, during.git!.branch, 'again.txt') === 'again', 15000) && onOrigin(bare, during.git!.branch, 'login.txt') === 'x', 'its new work goes on top of the old on origin');
  check(prCalls('create').filter((c) => c.includes(during.git!.branch)).length === 1, 'and no second pull request is opened');

  await sleep(500);
  office.shutdown();
  await mcp.close();
  check(errors.length === 0, 'the owner saw no error through all of it', errors.join(' | '));
}

finish();
