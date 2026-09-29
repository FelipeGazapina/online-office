// Two of an employee's subagents can ask permission at the same moment. The office holds the second question behind the
// first, shows one card at a time in the order they were asked, and both subagents get their answers.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-queue.mjs
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, claude, diagnoseClaude, hireClaudeInBlock, scratch, status, stepUntil, typeToNearest, walkUpToClaude } from './lib.mjs';

const { dataDir, repo } = scratch();

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: HAIKU,
  OFFICE_DEBUG: '1',
};

const write = (name) => `node -e "require('fs').writeFileSync('${name}', 'x')"`;

export default async (s) => {
  await hireClaudeInBlock(s, repo);
  assert(await walkUpToClaude(s), 'walked up to the employee');
  // Claude Code asks about parallel Bash calls in the same message one at a time, but two subagents run at once and each asks.
  await typeToNearest(
    s,
    `Use the Agent tool twice, both calls in one single message so the two subagents run in parallel. Subagent one must run exactly this command with the Bash tool: ${write('a.txt')} Subagent two must run exactly this command with the Bash tool: ${write('b.txt')} Reply done when both files exist.`,
  );
  await s.waitFor(`${status}.kind === 'working'`, 15000);
  await s.eval(`__office.teleport(-16.5, 5.9, Math.PI); __office.setCamera('follow'); __office.step(0.5)`);
  await s.waitFor(`${status}.kind === 'blocked_on_owner' && ${status}.question.kind === 'permission'`, 120000);
  const first = await s.eval(`${status}.question`);
  await stepUntil(s, `__office.state().askerId === ${claude}.id && !!document.querySelector('.qcard.permission')`, 60000, 'the first permission card');

  const deadline = Date.now() + 30000;
  while (!/permission question, 1 ahead of it/.test(s.mainLogs.join('\n')) && Date.now() < deadline) await s.sleep(250);
  console.log('inbox log:', s.mainLogs.join('\n').split('\n').filter((l) => l.includes('[inbox]')).join(' | '));
  assert(/permission question, 1 ahead of it/.test(s.mainLogs.join('\n')), 'a second permission question queued behind the first while its card was open');
  assert((await s.eval(`${status}.question.id`)) === first.id, 'the owner still sees the first question');
  console.log('first card:', first.detail);
  await s.shot('u1-queue-first-card');

  assert(await s.clickText('.qcard .opts button', 'Allow'), 'allowed the first');
  await s.waitFor(`${status}.kind === 'blocked_on_owner' && ${status}.question.id !== ${JSON.stringify(first.id)}`, 30000);
  const second = await s.eval(`${status}.question`);
  console.log('second card:', second.detail);
  assert(second.kind === 'permission' && second.detail !== first.detail, 'the second question shows once the first is answered');
  await stepUntil(s, `!!document.querySelector('.qcard.permission')`, 30000, 'the second card');
  await s.shot('u1-queue-second-card');
  assert(await s.clickText('.qcard .opts button', 'Allow'), 'allowed the second');

  // The employee is idle again as soon as the last card is answered: its own turn ended long before the subagents did.
  const files = [join(repo, 'a.txt'), join(repo, 'b.txt')];
  for (let i = 0; i < 240 && !files.every(existsSync); i++) await s.sleep(250);
  assert(files.every(existsSync), 'both commands ran (a.txt and b.txt exist)');
};

export const diagnose = (s) => diagnoseClaude(s, 'u1-queue-failure');
