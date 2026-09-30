import { normalizeTaskPayload } from '../src/main/office/task-board.ts';
import type { TaskBoardSource } from '../src/shared/protocol.ts';

const source: TaskBoardSource = { provider: 'cronospark', projectId: 'project-1' };
const result = normalizeTaskPayload('cronospark', {
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { tasks: [{ _id: 'task-1', code: 'CS-27', title: 'Fix the board', status: 'pending', priority: 2 }] } }) }],
}, source);
if (result.length !== 1) throw new Error(`expected one normalized card, got ${result.length}`);
const [card] = result;
if (card.id !== 'cronospark:task-1' || card.identifier !== 'CS-27' || card.status !== 'pending' || card.priority !== 'P2') throw new Error(`unexpected normalized card ${JSON.stringify(card)}`);
console.log('ok: CronoSpark MCP task payload becomes a normalized board card');
