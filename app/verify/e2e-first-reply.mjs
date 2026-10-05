// How long the owner waits for the first sign of an answer: ms from the post to the first stream event, the first say in the
// store, or the first message from the employee in the mail view. One warm-up message first, so the Claude process is
// already running, then three trials. Target under 2000 ms. The numbers are printed even when they miss it.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 OFFICE_DATA_DIR=$(mktemp -d) OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-first-reply.mjs
import { HAIKU, assert, claude, diagnoseClaude, hireClaudeInBlock, scratch, status } from './lib.mjs';

const { dataDir, repo } = scratch();

export const env = {
  OFFICE_DATA_DIR: process.env.OFFICE_DATA_DIR ?? dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: process.env.OFFICE_CLAUDE_MODEL ?? HAIKU,
};

const TARGET_MS = 2000;
const TRIALS = 3;

export const diagnose = (s) => diagnoseClaude(s, 'first-reply-failure');

export default async (s) => {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  const idle = () => s.waitFor(`${status}.kind === 'idle' && __office.store.getState().mail.open.length === 0`, 120000);

  // The page watches its own store, so the clock starts when the post leaves the renderer and stops on the first sign
  // of an answer, with no CDP round trip in between.
  await s.eval(`(() => {
    const id = ${JSON.stringify(id)};
    window.__firstReply = (text, clientId) => new Promise((resolve) => {
      const st0 = __office.store.getState();
      const seen = new Set(st0.mail.tail.map((m) => m.id));
      const said = (st0.chat[id] ?? []).length;
      let done = false;
      const finish = (kind) => { if (done) return; done = true; unsub(); resolve({ ms: performance.now() - t0, kind }); };
      const unsub = __office.store.subscribe((st) => {
        if (st.streams[id]) finish('stream');
        else if ((st.chat[id] ?? []).length > said) finish('say');
        else if (st.mail.tail.some((m) => !seen.has(m.id) && m.from === id)) finish('mail');
      });
      const t0 = performance.now();
      window.office.send({ type: 'post', to: id, clientId, as: 'request', text });
      setTimeout(() => finish('timeout'), 60000);
    });
  })()`);

  await s.eval(`window.__firstReply('Reply with the single word ready.', 'warmup')`);
  await idle();
  console.log('warm: the session is running');

  const results = [];
  for (let i = 1; i <= TRIALS; i++) {
    const r = await s.eval(`window.__firstReply('Say hello in one short sentence, then stop.', 'trial-${i}')`);
    results.push(r);
    console.log(`trial ${i}: ${Math.round(r.ms)} ms to the first ${r.kind}`);
    await idle();
  }
  const ms = results.map((r) => Math.round(r.ms));
  console.log(`first reply ms: ${JSON.stringify(ms)} (target < ${TARGET_MS}, median ${[...ms].sort((a, b) => a - b)[1]})`);
  assert(results.every((r) => r.kind !== 'timeout'), 'every trial saw an answer');
  const thread = await s.eval(`__office.store.getState().mail.tail.filter((m) => m.kind === 'reply').length`);
  assert(thread >= TRIALS, 'each request settled with a reply in the mail view');
  if (ms.some((n) => n >= TARGET_MS)) console.log(`NOTE: over the ${TARGET_MS} ms target in at least one trial`);
};
