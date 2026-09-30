import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linearToolArguments, normalizeTaskPayload, parseLinearSelector, TaskBoardService } from '../src/main/office/task-board.ts';
import { taskBoardColumns, type TaskBoardSource, type TaskCard } from '../src/shared/protocol.ts';

const cards: TaskCard[] = [
  { id: 'linear:1', provider: 'linear', identifier: 'BLOOM-1', title: 'Review', status: 'In Review', sourceLabel: 'Linear' },
  { id: 'linear:2', provider: 'linear', identifier: 'BLOOM-2', title: 'New', status: 'Todo', sourceLabel: 'Linear' },
  { id: 'linear:3', provider: 'linear', identifier: 'BLOOM-3', title: 'Unknown', status: 'Waiting on vendor', sourceLabel: 'Linear' },
];
const projected = taskBoardColumns(cards);
if (projected.map((column) => column.label).join('|') !== 'Open|Ready to Review|Waiting on vendor') throw new Error(`task board columns lost the Linear order or unknown state: ${JSON.stringify(projected.map((column) => column.label))}`);
if (projected.find((column) => column.label === 'Ready to Review')?.cards[0]?.id !== 'linear:1') throw new Error('review alias did not project to Ready to Review');
console.log('ok: task cards project into stable Linear-style columns and retain unknown states');

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
