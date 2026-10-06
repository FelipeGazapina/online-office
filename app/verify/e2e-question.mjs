// An owner question settles done with its answer, and an owner work order still has to show files. Real Claude agents on a
// scratch git repo: a question to an employee, a question to the PO (who answers it herself), a polite work order phrased as a
// question, and a plain work order. The ledger on disk and the chat DOM are what is asserted.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-question.mjs
// OFFICE_QUESTION_TRIALS=N adds N timed questions after the scenario, the owner pausing 8 s between them, and prints how
// long the first bubble took and how many were posted as questions. OFFICE_TRIAGE=0 turns the model's sorting off (the old
// behaviour, every owner message is work) and runs only those trials, as the baseline to compare their times with.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAIKU, assert, company } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'w7-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'w7-repo-')));
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

const ANSWER_WAIT_MS = 120_000;
const FIRST_BUBBLE_MAX_MS = 3000;
const HIRE_TO_FIRST_MESSAGE_MS = 8000;
const CALM_LOAD = 10;
const BASELINE = process.env.OFFICE_TRIAGE === '0';
const TRIALS = Number(process.env.OFFICE_QUESTION_TRIALS ?? (BASELINE ? 5 : 0));
const QUESTIONS = ['Where are the shout tests?', 'What is the test command in package.json?', 'How is the shout function tested?', 'What is this project called?', 'Does the README mention shout?', 'Which test file covers the empty string?', 'What version does package.json declare?', 'What does the README say about the project?'];

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
const requestOf = (key) => posts().find((m) => m.kind === 'request' && m.key === key);
const replyOf = (req) => posts().find((m) => m.kind === 'reply' && m.requestId === req.id);

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  const blockId = await s.eval(`${company}.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator' })`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Eli' })`);
  await s.waitFor(`${company}.employees.length === 2`);
  await s.eval('__office.step(25)');
  // The acknowledgement and triage processes are replaced after each use, and a session warms at hire.
  await s.sleep(HIRE_TO_FIRST_MESSAGE_MS);
  const people = await s.eval(`${company}.employees.map((e) => ({ id: e.id, name: e.name }))`);
  const idOf = (name) => people.find((e) => e.name === name).id;
  const eli = idOf('Eli');
  const pia = idOf('Pia');
  await s.eval(`__office.set({ selectedId: ${JSON.stringify(eli)} })`);
  await s.waitFor(`!!document.querySelector('.cp-thread')`);

  // The owner speaks from the renderer, as the composer does. Returns the ms to the first bubble of the employee's answer.
  await s.eval(`window.__send = (to, text, clientId) => new Promise((resolve) => {
    const seen = new Set(__office.store.getState().mail.tail.map((m) => m.id));
    const stale = __office.store.getState().streams[to];
    let done = false;
    const finish = (kind) => { if (done) return; done = true; unsub(); resolve({ kind, ms: Math.round(performance.now() - t0) }); };
    const unsub = __office.store.subscribe((st) => {
      if (st.streams[to] && st.streams[to] !== stale) finish('stream');
      else if (st.mail.tail.some((m) => !seen.has(m.id) && m.from === to && m.kind === 'say')) finish('say');
    });
    const t0 = performance.now();
    window.office.send({ type: 'post', to, clientId, as: 'request', text });
    setTimeout(() => finish('timeout'), 30000);
  })`);

  // Triage has a 2.5 s leash and falls back to work, so on a machine another job is flattening the questions would come back
  // as blocked for a reason this script is not about. Wait for a quiet minute before each message, up to two minutes.
  const calm = async () => {
    for (let waited = 0; loadavg()[0] > CALM_LOAD && waited < 120_000; waited += 5000) await s.sleep(5000);
    if (loadavg()[0] > CALM_LOAD) console.log(`load ${loadavg()[0].toFixed(1)} did not drop under ${CALM_LOAD}, going on`);
  };
  const ask = async (to, text, key) => {
    await calm();
    const bubble = await s.eval(`window.__send(${JSON.stringify(to)}, ${JSON.stringify(text)}, ${JSON.stringify(key)})`);
    const t0 = Date.now();
    while (Date.now() - t0 < ANSWER_WAIT_MS) {
      const req = requestOf(key);
      const reply = req && replyOf(req);
      if (reply) return { req, reply, bubble, settledMs: Date.now() - t0 };
      await s.sleep(500);
    }
    throw new Error(`no reply to "${text}" after ${ANSWER_WAIT_MS / 1000} s; ledger tail ${JSON.stringify(posts().slice(-4))}`);
  };
  const quiet = (id) => s.waitFor(`${company}.employees.find((e) => e.id === ${JSON.stringify(id)}).status.kind === 'idle'`, 240000);

  if (!BASELINE) {
    // A question to an employee.
    const q1 = await ask(eli, 'Which file defines the shout function?', 'q-eli');
    console.log(`first bubble ${q1.bubble.ms} ms (${q1.bubble.kind}), settled ${q1.settledMs} ms after the first bubble: ${JSON.stringify(q1.reply.text)}`);
    assert(q1.req.intent === 'help', 'a question to an employee is posted as help');
    assert(q1.reply.outcome === 'done' && /shout\.js/.test(q1.reply.text) && !q1.reply.artifact?.length, 'and settles done with the answer and no files');
    assert(q1.bubble.kind !== 'timeout' && q1.bubble.ms < FIRST_BUBBLE_MAX_MS, `with the first bubble in ${q1.bubble.ms} ms (limit ${FIRST_BUBBLE_MAX_MS})`);
    await quiet(eli);
    await s.waitFor(`[...document.querySelectorAll('.thread .msg.employee')].some((m) => /shout\\.js/.test(m.innerText))`, 10000);
    assert(true, 'the answer is a bubble in the chat');
    const chips = await s.eval(`[...document.querySelectorAll('.thread .cp-chip')].map((c) => c.innerText)`);
    assert(chips.includes('done') && !chips.includes('blocked'), `the owner's message shows done, not blocked (chips ${JSON.stringify(chips)})`);

    // A question to the PO is hers to answer.
    const q2 = await ask(pia, 'What does the shout function return for an empty string?', 'q-po');
    console.log(`PO: first bubble ${q2.bubble.ms} ms, settled ${q2.settledMs} ms after it: ${JSON.stringify(q2.reply.text)}`);
    assert(q2.req.intent === 'help' && q2.reply.outcome === 'done' && q2.reply.from === pia && q2.reply.text.trim().length > 0, 'a question to the PO is posted as help and the PO settles it done');
    assert(!posts().some((m) => m.kind === 'request' && m.rootId === q2.req.id && m.id !== q2.req.id), 'and she answered it herself, with no request to anyone');
    await quiet(pia);

    // A polite work order phrased as a question still has to show files.
    const w1 = await ask(eli, 'Could you create a file named polite.txt containing the single word hello?', 'w-polite');
    console.log(`polite order: first bubble ${w1.bubble.ms} ms: ${JSON.stringify(w1.reply.text)} artifact ${JSON.stringify(w1.reply.artifact)}`);
    assert(w1.req.intent === 'work', 'a polite order phrased as a question is posted as work');
    assert(w1.reply.outcome === 'done' && w1.reply.artifact?.some((a) => /polite\.txt/.test(a)), 'and settles done only with the file it made named');
    await quiet(eli);

    // A plain work order.
    const w2 = await ask(eli, 'Create a file named plain.txt containing the single word hello, then tell me it is done.', 'w-plain');
    assert(w2.req.intent === 'work' && w2.reply.outcome === 'done' && w2.reply.artifact?.some((a) => /plain\.txt/.test(a)), 'a plain order is work and settles done with its file');
    await quiet(eli);
    await s.shot('w7-question');
  }

  const timed = [];
  for (let i = 0; i < TRIALS; i++) {
    await s.sleep(HIRE_TO_FIRST_MESSAGE_MS);
    const q = await ask(eli, QUESTIONS[i % QUESTIONS.length], `trial-${i}`);
    timed.push({ ms: q.bubble.ms, help: q.req.intent === 'help', outcome: q.reply.outcome });
    console.log(`trial ${i + 1} at load ${loadavg()[0].toFixed(1)}: first bubble ${q.bubble.ms} ms (${q.bubble.kind}), posted as ${q.req.intent}, settled ${q.reply.outcome}`);
    await quiet(eli);
  }
  if (timed.length) {
    const ms = timed.map((t) => t.ms).sort((a, b) => a - b);
    console.log(`question first bubble ms ${JSON.stringify(ms)}: p50 ${ms[Math.floor((ms.length - 1) / 2)]}, max ${ms.at(-1)}; posted as help ${timed.filter((t) => t.help).length}/${timed.length}; settled done ${timed.filter((t) => t.outcome === 'done').length}/${timed.length}`);
  }
};

export const diagnose = async (s) => {
  console.log('ledger tail:', JSON.stringify(posts().slice(-6)));
  console.log('people:', await s.eval(`JSON.stringify(${company}.employees.map((e) => ({ name: e.name, status: e.status, activity: e.activity })))`));
  console.log('chips:', await s.eval(`JSON.stringify([...document.querySelectorAll('.cp-chip')].map((c) => c.innerText))`));
};
