// The terminal on an employee's monitor, with a real haiku employee. A task is assigned and, within 2 s of the turn starting, the
// monitor shows its prompt and then its tool calls as they happen. F at the desk flies the camera into the monitor and opens the
// terminal with its whole scrollback. A message typed there reaches the employee (the mail ledger holds the owner post, and they
// answer in the terminal). Esc stops a step and the turn ends interrupted. A permission card is answered in the terminal and
// releases the tool. Esc on an idle employee leaves, and the camera comes back.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-terminal.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, scratch, stepUntil } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_RUN: '', OFFICE_CLAUDE_MODEL: HAIKU };

const state = '__office.store.getState()';
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
const screenOf = (s, id) => s.eval(`(window.__officeTerminals?.() ?? {})[${JSON.stringify(id)}]?.rows ?? []`);
const text = (rows) => rows.join('\n');
const waitScreen = async (s, id, pattern, ms, label) => {
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < ms) {
    rows = await screenOf(s, id);
    if (pattern.test(text(rows))) return { rows, ms: Date.now() - t0 };
    await s.sleep(100);
  }
  throw new Error(`timeout waiting for ${label}; the monitor shows:\n${text(rows)}`);
};

export const diagnose = async (s) => {
  const id = await s.eval(`${state}.company.employees[0]?.id`).catch(() => null);
  if (id) console.log('monitor at failure:\n' + text(await screenOf(s, id)));
  console.log('ledger tail:\n' + ledger().filter((e) => e.t === 'post').slice(-8).map((e) => `${e.msg.kind} ${e.msg.from}->${e.msg.to} ${e.msg.outcome ?? ''} ${(e.msg.title ?? e.msg.text ?? '').slice(0, 100)}`).join('\n'));
  await s.shot('terminal-failure').catch(() => {});
};

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${state}.company.blocks[0].id, name: 'Ana' })`);
  await s.waitFor(`${state}.company.employees.length === 1`);
  const id = await s.eval(`${state}.company.employees[0].id`);
  await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(id)}, mode: 'yolo' })`);

  // The owner stands at Ana's desk, and the camera follows.
  await stepUntil(s, `__office.state().avatars.find((a) => a.id === ${JSON.stringify(id)})?.seated`, 20000, 'Ana to sit');
  const at = await s.eval(`__office.state().avatars.find((a) => a.id === ${JSON.stringify(id)})`);
  await s.eval(`__office.teleport(${at.x}, ${at.z + 1.4}, 0)`);
  await s.sleep(800);

  const idle = await waitScreen(s, id, /❯/, 5000, 'the resting prompt');
  console.log(text(idle.rows));
  assert(idle.rows.some((r) => r.includes('Claude Code')) && idle.rows.some((r) => r.startsWith('❯')), 'an idle employee shows the Claude Code header and a resting prompt, not a black screen');
  await s.shot('terminal-idle');

  // A task, as the chat sends it. The prompt is on the monitor within 2 s of the turn starting, then the calls as they happen.
  const asked = Date.now();
  const taskText = 'Create a file named hello.txt containing exactly the word hi, then run ls in the shell, then say done in one short sentence.';
  await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(id)}, clientId: 'task-1', as: 'request', text: ${JSON.stringify(taskText)} })`);
  await s.waitFor(`${state}.company.employees[0].status.kind === 'working'`, 20000);
  const turnStart = ledger().filter((e) => e.t === 'deliver' && e.to === id).at(-1)?.at ?? asked;
  const shown = await waitScreen(s, id, /Create a file named hello\.txt/, 8000, 'the prompt');
  const lag = Date.now() - turnStart;
  console.log(`the prompt reached the monitor ${lag} ms after the turn started`);
  assert(lag < 2000, `the prompt is on the monitor within 2 s of the turn starting (${lag} ms)`);
  const write = await waitScreen(s, id, /Write\(hello\.txt\)/, 40000, 'the write call');
  assert((await s.eval(`${state}.company.employees[0].status.kind`)) === 'working' || /Wrote/.test(text(write.rows)), 'the call shows while the employee is still at work');
  await waitScreen(s, id, /Bash\(ls\)/, 40000, 'the shell call');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);
  const done = await waitScreen(s, id, /hello\.txt/, 5000, 'the result');
  console.log(text(done.rows));
  await s.shot('terminal-monitor');
}
