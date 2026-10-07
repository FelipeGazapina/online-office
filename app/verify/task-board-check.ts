import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { linearToolArguments, normalizeTaskPayload, parseLinearSelector, TaskBoardService } from '../src/main/office/task-board.ts';
import type { LinearFilters, TaskBoardSource, TaskCard } from '../src/shared/protocol.ts';
import { stageOfStatus, wantsCard, type TaskStage } from '../src/shared/tasks.ts';
import { linearWorld, ME, startFakeLinear, TEAM, TOKEN, type FakeIssue, type FakeLinearOptions } from './fake-linear.ts';

const source: TaskBoardSource = { provider: 'cronospark', projectId: 'project-1' };
const result = normalizeTaskPayload('cronospark', {
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { tasks: [{ _id: 'task-1', code: 'CS-27', title: 'Fix the board', status: 'pending', priority: 2 }] } }) }],
}, source);
if (result.length !== 1) throw new Error(`expected one normalized card, got ${result.length}`);
const [card] = result;
if (card.id !== 'cronospark:task-1' || card.identifier !== 'CS-27' || card.status !== 'pending' || card.priority !== 'P2') throw new Error(`unexpected normalized card ${JSON.stringify(card)}`);
console.log('ok: CronoSpark MCP task payload becomes a normalized board card');

const teamSelector = parseLinearSelector('https://linear.app/bloomnetwork/team/BLOOM/active');
if (teamSelector.kind !== 'team' || teamSelector.team !== 'BLOOM' || teamSelector.workspace !== 'bloomnetwork') throw new Error(`Linear team URL was not parsed safely: ${JSON.stringify(teamSelector)}`);
const teamArgs = linearToolArguments({ name: 'list_issues', inputSchema: { properties: { teamId: {}, workspace: {}, projectId: {} } } }, { provider: 'linear', projectId: 'https://linear.app/bloomnetwork/team/BLOOM/active' });
if (teamArgs.args.teamId !== 'BLOOM' || teamArgs.args.workspace !== 'bloomnetwork' || 'projectId' in teamArgs.args) throw new Error(`Linear team arguments were mapped incorrectly: ${JSON.stringify(teamArgs)}`);
const workspaceArgs = linearToolArguments({ name: 'list_issues', inputSchema: { properties: { projectId: {} } } }, { provider: 'linear', projectId: 'bloomnetwork' });
if (Object.keys(workspaceArgs.args).length || !workspaceArgs.unfilteredWorkspace) throw new Error(`A workspace without a workspace filter must use the authenticated workspace: ${JSON.stringify(workspaceArgs)}`);
const projectArgs = linearToolArguments({ name: 'list_issues', inputSchema: { properties: { project: {}, team: {}, workspace: {} } } }, { provider: 'linear', projectId: 'project:proj_123' });
if (projectArgs.args.project !== 'proj_123' || Object.keys(projectArgs.args).length !== 1) throw new Error(`Linear project arguments were mapped incorrectly: ${JSON.stringify(projectArgs)}`);
console.log('ok: Linear selectors map team URLs, workspaces, and explicit projects without project-field leakage');

const credentialsFile = join(mkdtempSync(join(tmpdir(), 'office-task-board-')), 'credentials.json');
const service = new TaskBoardService({ credentialsFile });
service.configureCronoSpark('Bearer test-api-key', 'test-user');
const saved = readFileSync(credentialsFile, 'utf8');
if (!saved.includes('test-api-key') || (statSync(credentialsFile).mode & 0o077) !== 0) throw new Error('CronoSpark credentials are not stored in a private file');
const restored = new TaskBoardService({ credentialsFile });
const connection = restored.connectionStates().cronospark;
if (connection.kind !== 'ready' || connection.userId !== 'test-user' || JSON.stringify(connection).includes('test-api-key')) throw new Error(`credentials did not restore safely: ${JSON.stringify(connection)}`);
console.log('ok: CronoSpark credentials persist privately without entering the snapshot');

const linearCredentialsFile = join(mkdtempSync(join(tmpdir(), 'office-linear-')), 'credentials.json');
writeFileSync(linearCredentialsFile, JSON.stringify({ linear: { tokens: { access_token: 'test-linear-token', token_type: 'bearer' } } }));
const linearService = new TaskBoardService({ credentialsFile: linearCredentialsFile });
const linearConnection = linearService.connectionStates().linear;
if (linearConnection.kind !== 'ready' || JSON.stringify(linearConnection).includes('test-linear-token')) throw new Error(`Linear OAuth credentials did not restore safely: ${JSON.stringify(linearConnection)}`);
console.log('ok: Linear OAuth credentials restore as a ready private connection');

const expect = (cond: boolean, msg: string, detail?: unknown) => {
  if (!cond) throw new Error(`${msg}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log('ok:', msg);
};

const world = linearWorld();
const recent = [...world.issues].sort((a, b) => b.updatedAt - a.updatedAt);
const closed = (i: FakeIssue) => i.status.type === 'completed' || i.status.type === 'canceled';
const want = (match: (i: FakeIssue) => boolean, limit: number) => recent.filter(match).slice(0, limit).map((i) => i.identifier);
const idsOf = (cards: TaskCard[]) => cards.map((c) => c.identifier);

const linear = (filters?: Partial<LinearFilters>, projectId = `team:${TEAM}`): TaskBoardSource => ({ provider: 'linear', projectId, ...(filters ? { filters: { assignee: 'anyone', cycle: 'any', limit: 50, ...filters } } : {}) });

process.env.LINEAR_MCP_TOKEN = TOKEN;
const pull = async (fake: { url: string; calls: unknown[] }, source: TaskBoardSource, collapsed: TaskStage[] = []) => {
  process.env.LINEAR_MCP_URL = fake.url;
  fake.calls.splice(0);
  return new TaskBoardService().fetchSources([source], (card) => wantsCard({ collapsed }, card));
};

const fake = await startFakeLinear(world);
const calls = () => fake.calls.map((c) => `${c.tool} ${JSON.stringify(c.args)}`);

const baselineClient = new Client({ name: 'baseline', version: '0' });
await baselineClient.connect(new StreamableHTTPClientTransport(new URL(fake.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
const baseline = normalizeTaskPayload('linear', await baselineClient.callTool({ name: 'list_issues', arguments: { team: TEAM } }), linear());
await baselineClient.close();
expect(baseline.length === 50, 'the baseline is the 50 issues Linear answers with when asked for the team only');

const defaults = await pull(fake, linear());
expect(JSON.stringify(idsOf(defaults.cards)) === JSON.stringify(idsOf(baseline)) && !defaults.errors.length, 'a source with no filters returns what it always did: the same 50 issues');
expect(calls().length === 1 && JSON.stringify(fake.calls[0]!.args) === JSON.stringify({ team: TEAM, limit: 50 }), 'in one call that says the team and the limit and nothing about people or cycles', calls());
expect(JSON.stringify(idsOf((await pull(fake, linear({ assignee: 'anyone', cycle: 'any', limit: 50 }))).cards)) === JSON.stringify(idsOf(baseline)), 'filters spelled out as the defaults are the same call');

const mine = await pull(fake, linear({ assignee: 'me', limit: 200 }));
expect(JSON.stringify(idsOf(mine.cards)) === JSON.stringify(want((i) => i.assignee === ME.id, 200)) && mine.cards.length === 51, 'assignee "me" returns only the owner\'s 51 issues', mine.errors);
expect(fake.calls[0]!.args.assignee === 'me', 'asked through the tool\'s assignee filter, with the word Linear takes for the signed-in person', calls());
expect((await pull(fake, linear({ assignee: 'me' }))).cards.length === 50, 'and the limit still caps them');

const ana = await pull(fake, linear({ assignee: { id: 'u-ana', name: 'Ana' }, limit: 200 }));
expect(JSON.stringify(idsOf(ana.cards)) === JSON.stringify(want((i) => i.assignee === 'u-ana', 200)) && ana.cards.length === 51 && fake.calls[0]!.args.assignee === 'u-ana', 'a picked person returns only theirs, asked by their id');

const cycle = await pull(fake, linear({ cycle: 'current', limit: 200 }));
expect(JSON.stringify(idsOf(cycle.cards)) === JSON.stringify(want((i) => i.cycle === 'cy-7', 200)) && cycle.cards.length === 150, 'cycle current returns only the current cycle\'s 150 issues', cycle.errors);
expect(fake.calls[0]!.tool === 'list_cycles' && JSON.stringify(fake.calls[0]!.args) === JSON.stringify({ teamId: TEAM, type: 'current' }) && fake.calls[1]!.args.cycle === 'cy-7', 'the team\'s current cycle is looked up first and its id is what list_issues is asked for', calls());

const both = await pull(fake, linear({ assignee: 'me', cycle: 'current', limit: 200 }));
expect(JSON.stringify(idsOf(both.cards)) === JSON.stringify(want((i) => i.assignee === ME.id && i.cycle === 'cy-7', 200)) && both.cards.length === 25, 'assignee and cycle together narrow to the 25 that match both');

const big = await pull(fake, linear({ limit: 200 }));
expect(big.cards.length === 200 && JSON.stringify(idsOf(big.cards)) === JSON.stringify(want(() => true, 200)), 'limit 200 returns 200 issues, the 200 most recent');
expect(fake.calls.length === 1 && fake.calls[0]!.args.limit === 200, 'in one call, because the tool takes up to 250', calls());

const small = await startFakeLinear({ ...world, maxLimit: 100 });
const paged = await pull(small, linear({ limit: 200 }));
expect(JSON.stringify(idsOf(paged.cards)) === JSON.stringify(want(() => true, 200)) && small.calls.length === 2, 'a tool that stops at 100 is paged: two calls give the same 200', small.calls.map((c) => JSON.stringify(c.args)));
expect(small.calls.every((c) => c.args.limit === 100) && small.calls[0]!.args.cursor === undefined && typeof small.calls[1]!.args.cursor === 'string', 'each asks for 100, and the second continues from the cursor the first returned');
await small.close();

const older = await startFakeLinear({ ...world, maxLimit: 100, paging: 'after' });
const afterPaged = await pull(older, linear({ limit: 200 }));
expect(JSON.stringify(idsOf(afterPaged.cards)) === JSON.stringify(want(() => true, 200)) && older.calls[1]!.args.after === 'iss-099', 'a tool that pages with `after` and returns no cursor is continued from the last issue it gave', older.calls.map((c) => JSON.stringify(c.args)));
await older.close();

const firstPage = recent.slice(0, 50);
expect(firstPage.filter(closed).length === 22, 'without folding, 22 of the 50 are done or canceled');
const noDone = await pull(fake, linear(), ['done']);
expect(noDone.cards.length === 50 && noDone.cards.every((c) => stageOfStatus(c.status) !== 'done'), 'with Done folded, all 50 are in the other columns');
expect(JSON.stringify(idsOf(noDone.cards)) === JSON.stringify(want((i) => !closed(i), 50)), 'and they are the 50 most recent open issues, not the first page with the closed ones cut out');
expect(fake.calls.length === 2 && fake.calls.every((c) => c.args.limit === 50) && fake.calls[1]!.args.cursor === 'c:50', 'it took a second page to fill them', calls());
const noDone200 = await pull(fake, linear({ limit: 200 }), ['done']);
expect(noDone200.cards.length === 171 && JSON.stringify(idsOf(noDone200.cards)) === JSON.stringify(want((i) => !closed(i), 200)), 'at limit 200 every open issue fits: 171, with 129 done or canceled left behind');
const inProgress = (i: FakeIssue) => i.status.name === 'In Progress' || i.status.name === 'In Review';
const middle = await pull(fake, linear({ limit: 200 }), ['todo', 'done']);
expect(JSON.stringify(idsOf(middle.cards)) === JSON.stringify(want(inProgress, 200)), 'folding Todo too leaves only In Progress and In Review');
const expanded = await pull(fake, linear(), []);
expect(JSON.stringify(idsOf(expanded.cards)) === JSON.stringify(idsOf(baseline)), 'unfolding brings the closed ones back on the next pull');
const mineNoDone = await pull(fake, linear({ assignee: 'me', limit: 200 }), ['done']);
expect(JSON.stringify(idsOf(mineNoDone.cards)) === JSON.stringify(want((i) => i.assignee === ME.id && !closed(i), 200)), 'a fold and an assignee filter work together');

const noAssignee = await startFakeLinear({ ...world, without: ['assignee'] });
const refusedMe = await pull(noAssignee, linear({ assignee: 'me' }));
expect(!refusedMe.cards.length && /cannot filter by assignee/.test(refusedMe.errors.join()), 'a tool with no assignee filter makes the sync fail instead of showing everyone\'s issues', refusedMe.errors);
expect((await pull(noAssignee, linear())).cards.length === 50, 'and the same tool still works with no filter');
await noAssignee.close();
const noCycle = await startFakeLinear({ ...world, without: ['cycle'] });
expect(/cannot filter by cycle/.test((await pull(noCycle, linear({ cycle: 'current' }))).errors.join()), 'likewise for the cycle');
await noCycle.close();

const lenient = await startFakeLinear({ ...world, acceptsCurrent: true });
const viaWord = await pull(lenient, linear({ cycle: 'current', limit: 200 }, 'project:ROADMAP'));
expect(lenient.calls.length === 1 && lenient.calls[0]!.args.cycle === 'current' && viaWord.cards.length === 150, 'a project source asks for the cycle "current" in so many words', lenient.calls.map((c) => JSON.stringify(c.args)));
await lenient.close();
expect(/Cycle not found: current/.test((await pull(fake, linear({ cycle: 'current' }, 'project:ROADMAP'))).errors.join()), 'and when the tool does not take that word, the sync says so');

const wrong = await pull(fake, linear());
process.env.LINEAR_MCP_TOKEN = 'not-the-token';
const unauthorized = await pull(fake, linear());
process.env.LINEAR_MCP_TOKEN = TOKEN;
expect(wrong.cards.length === 50 && !unauthorized.cards.length && unauthorized.errors.length === 1, 'a bad token is an error, not an empty board', unauthorized.errors);

process.env.LINEAR_MCP_URL = fake.url;
fake.calls.splice(0);
const people = await new TaskBoardService().linearPeople();
expect(people.length === 70 && people.some((p) => p.id === 'u-ana' && p.name === 'Ana') && people.every((p, i) => i === 0 || people[i - 1]!.name.localeCompare(p.name) <= 0), 'the picker gets all 70 people, by name', people.length);
expect(fake.calls.length === 1 && fake.calls[0]!.tool === 'list_users', 'in one call to list_users', calls());
await fake.close();
const narrow = await startFakeLinear({ ...world, maxLimit: 40 });
process.env.LINEAR_MCP_URL = narrow.url;
const inPages = await new TaskBoardService().linearPeople();
expect(inPages.length === 70 && narrow.calls.length === 2 && narrow.calls.every((c) => c.tool === 'list_users'), 'a user list that pages at 40 is read to its end', narrow.calls.map((c) => JSON.stringify(c.args)));
await narrow.close();
delete process.env.LINEAR_MCP_TOKEN;
delete process.env.LINEAR_MCP_URL;

