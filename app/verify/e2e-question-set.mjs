// The fixed 30 owner messages of verify/owner-messages.ts (set A, or B with OFFICE_QUESTION_SET=B) through the real app, as
// shipped: the post, the triage with its 2.5 s leash, the mailroom and a real Claude employee on a scratch git repo. A question
// is let run and must settle. A work order is cancelled as soon as the ledger shows how it was posted, so the 15 orders do not
// run, and what is checked is the intent the ledger recorded and that nothing settled done without a file.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-question-set.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAIKU, assert, company } from './lib.mjs';
import { SET_A, SET_B } from './owner-messages.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'w7-set-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'w7-set-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' });
git('init', '-q');
cpSync(join(HERE, 'fixtures', 'company-project'), repo, { recursive: true });
git('add', '-A');
git('commit', '-q', '-m', 'initial');

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: process.env.OFFICE_CLAUDE_MODEL ?? HAIKU,
};

const SET = process.env.OFFICE_QUESTION_SET === 'B' ? SET_B : SET_A;
const CALM_LOAD = 10;
const WAIT_MS = 150_000;

const posts = () => {
  const file = join(dataDir, 'company.mail.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e.t === 'post' ? [e.msg] : [];
    } catch {
      return [];
    }
  });
};

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  const blockId = await s.eval(`${company}.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Eli' })`);
  await s.waitFor(`${company}.employees.length === 1`);
  const eli = await s.eval(`${company}.employees[0].id`);
  await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(eli)}, mode: 'yolo' })`);
  await s.eval('__office.step(25)');
  await s.sleep(12_000);

  const idle = () => s.waitFor(`${company}.employees[0].status.kind === 'idle'`, 240_000);
  const calm = async () => {
    for (let waited = 0; loadavg()[0] > CALM_LOAD && waited < 120_000; waited += 5000) await s.sleep(5000);
  };
  const until = async (pick, what) => {
    for (let t0 = Date.now(); Date.now() - t0 < WAIT_MS; await s.sleep(400)) {
      const hit = pick();
      if (hit) return hit;
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const rows = [];
  for (const [i, m] of SET.entries()) {
    await calm();
    const key = `set-${i}`;
    await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(eli)}, clientId: ${JSON.stringify(key)}, as: 'request', text: ${JSON.stringify(m.text)} })`);
    const req = await until(() => posts().find((p) => p.kind === 'request' && p.key === key), `the post of "${m.text}"`);
    if (m.is === 'work') await s.eval(`window.office.send({ type: 'cancel_message', messageId: ${JSON.stringify(req.id)} })`);
    const reply = await until(() => posts().find((p) => p.kind === 'reply' && p.requestId === req.id), `the reply to "${m.text}"`);
    rows.push({ ...m, posted: req.intent, outcome: reply.outcome, artifact: reply.artifact?.length ?? 0, answer: reply.text });
    console.log(`${m.is.padEnd(8)} posted as ${req.intent.padEnd(4)} settled ${reply.outcome.padEnd(9)} load ${loadavg()[0].toFixed(1).padStart(5)} | ${m.text}`);
    await idle();
  }

  const cell = (is, posted) => rows.filter((r) => r.is === is && r.posted === posted).length;
  console.log('\n                  posted as help   posted as work');
  console.log(`is question       ${String(cell('question', 'help')).padStart(14)}   ${String(cell('question', 'work')).padStart(14)}`);
  console.log(`is work           ${String(cell('work', 'help')).padStart(14)}   ${String(cell('work', 'work')).padStart(14)}`);
  const questions = rows.filter((r) => r.is === 'question');
  console.log(`questions settled done ${questions.filter((r) => r.outcome === 'done').length}/${questions.length}, blocked ${questions.filter((r) => r.outcome === 'blocked').length}`);
  assert(rows.filter((r) => r.is === 'work' && r.outcome === 'done' && r.artifact === 0).length === 0, 'no work order settled done without a file');
  assert(cell('work', 'help') === 0, 'no work order was posted as a question');
  assert(questions.filter((r) => r.outcome === 'blocked').length <= 1, `at most one question settled blocked (${questions.filter((r) => r.outcome === 'blocked').length})`);
  assert(questions.every((r) => r.outcome === 'done' ? r.answer.trim().length > 0 : true), 'every question settled done carries its answer');
};

export const diagnose = async () => {
  console.log('ledger tail:', JSON.stringify(posts().slice(-4)));
};
