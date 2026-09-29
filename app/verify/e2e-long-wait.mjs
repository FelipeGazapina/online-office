// A real Claude employee asks the owner a question over the office MCP server, and the owner answers only after a long
// silence. Nothing between Claude and the office may give up on a slow owner, and the employee must still get the
// answer and finish the task.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-long-wait.mjs
// Longer wait, past Claude Code's 5 minute default silence limit: OFFICE_LONG_WAIT_S=330 node verify/cdp.mjs verify/e2e-long-wait.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, claude, diagnoseClaude, hireClaudeInBlock, logLines, scratch, status, stepUntil, typeToNearest, walkUpToClaude } from './lib.mjs';

const WAIT_S = Number(process.env.OFFICE_LONG_WAIT_S ?? 150);
const { dataDir, repo } = scratch();

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: HAIKU,
  OFFICE_DEBUG: '1',
};

export default async (s) => {
  await hireClaudeInBlock(s, repo);
  assert(await walkUpToClaude(s), 'walked up to the employee');
  await typeToNearest(
    s,
    'Call the ask_owner tool to ask me for the codeword, with exactly two options: PINEAPPLE and MANGO. Then write exactly the option I choose into codeword.txt in this folder, and reply done.',
  );
  await s.waitFor(`${status}.kind === 'working'`, 15000);
  await s.eval(`__office.teleport(-16.5, 5.9, Math.PI); __office.setCamera('follow'); __office.step(0.5)`);
  await s.waitFor(`${status}.kind === 'blocked_on_owner'`, 120000);
  const question = await s.eval(`${status}.question`);
  const askedAt = Date.now();
  console.log('question:', JSON.stringify(question));
  await stepUntil(s, `__office.state().askerId === ${claude}.id && !!document.querySelector('.qcard')`, 60000, 'the employee to reach the owner and show the card');

  for (let waited = 0; Date.now() - askedAt < WAIT_S * 1000; ) {
    await s.sleep(Math.min(10000, WAIT_S * 1000 - (Date.now() - askedAt)));
    const now = await s.eval(status);
    if (now.kind !== 'blocked_on_owner' || now.question.id !== question.id) throw new Error(`the question went away after ${((Date.now() - askedAt) / 1000).toFixed(0)}s: ${JSON.stringify(now)}`);
    if ((waited += 1) % 3 === 0) console.log(`  ${((Date.now() - askedAt) / 1000).toFixed(0)}s: still waiting on the owner`);
  }
  const waitedS = (Date.now() - askedAt) / 1000;
  assert(waitedS >= WAIT_S, `the owner stayed silent for ${waitedS.toFixed(0)}s (wanted ${WAIT_S}s) and the employee was still blocked on the same question`);
  await s.shot('u1-long-wait-card');

  const chosen = await s.eval(`(() => { const b = document.querySelectorAll('.qcard .opts button')[0]; b.click(); return b.innerText; })()`);
  console.log('answered on the card:', chosen);
  await s.waitFor(`${status}.kind === 'idle'`, 120000);
  const file = join(repo, 'codeword.txt');
  assert(existsSync(file), 'codeword.txt exists in the block folder');
  const content = readFileSync(file, 'utf8');
  console.log('codeword.txt =', JSON.stringify(content));
  assert(content.toUpperCase().includes(chosen.trim().toUpperCase()), `the employee received the answer after ${waitedS.toFixed(0)}s and wrote ${chosen.trim()} into the file`);

  const done = /\[mcp\] \S+ ask_owner done after ([\d.]+)s/.exec(s.mainLogs.join('\n'));
  console.log('main log:', done?.[0]);
  assert(done && Number(done[1]) >= WAIT_S, `the office logged ask_owner open for ${done?.[1]}s over http`);
  console.log('employee log:\n  ' + (await logLines(s)).join('\n  '));
};

export const diagnose = (s) => diagnoseClaude(s, 'u1-long-wait-failure');
