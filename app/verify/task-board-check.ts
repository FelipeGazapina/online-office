import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeTaskPayload, TaskBoardService } from '../src/main/office/task-board.ts';
import type { TaskBoardSource } from '../src/shared/protocol.ts';

const source: TaskBoardSource = { provider: 'cronospark', projectId: 'project-1' };
const result = normalizeTaskPayload('cronospark', {
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { tasks: [{ _id: 'task-1', code: 'CS-27', title: 'Fix the board', status: 'pending', priority: 2 }] } }) }],
}, source);
if (result.length !== 1) throw new Error(`expected one normalized card, got ${result.length}`);
const [card] = result;
if (card.id !== 'cronospark:task-1' || card.identifier !== 'CS-27' || card.status !== 'pending' || card.priority !== 'P2') throw new Error(`unexpected normalized card ${JSON.stringify(card)}`);
console.log('ok: CronoSpark MCP task payload becomes a normalized board card');

const credentialsFile = join(mkdtempSync(join(tmpdir(), 'office-task-board-')), 'credentials.json');
const service = new TaskBoardService({ credentialsFile });
service.configureCronoSpark('Bearer test-api-key', 'test-user');
const saved = readFileSync(credentialsFile, 'utf8');
if (!saved.includes('test-api-key') || (statSync(credentialsFile).mode & 0o077) !== 0) throw new Error('CronoSpark credentials are not stored in a private file');
const restored = new TaskBoardService({ credentialsFile });
const connection = restored.connectionStates().cronospark;
if (connection.kind !== 'ready' || connection.userId !== 'test-user' || JSON.stringify(connection).includes('test-api-key')) throw new Error(`credentials did not restore safely: ${JSON.stringify(connection)}`);
console.log('ok: CronoSpark credentials persist privately without entering the snapshot');
