// A task's pull request number takes the owner to their Mac with the pull request open on GitHub, from the card and from the
// task's detail, with real clicks. The task is real; its pull request is set on the renderer's copy, so no gh or agent runs.
// A test run logs the URL the Mac's browser would open instead of opening it.
// Run: pnpm build && OFFICE_CDP_PORT=9350 node verify/cdp.mjs verify/e2e-pr-computer.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const state = '__office.store.getState()';
const PR = { number: 42, url: 'https://github.com/FelipeGazapina/online-office/pull/42', state: 'open' };
const seat = (s) => s.eval(`({ computerState: ${state}.computerState, computerView: ${state}.computerView, portalMode: ${state}.portalMode, modal: ${state}.modal })`);
const opened = (s) => s.mainLogs.filter((l) => l.includes('[portal] open')).join('\n');

async function openBoard(s, blockId, taskId) {
  await s.eval(`__office.store.setState({ modal: { kind: 'task_board', blockId: ${JSON.stringify(blockId)}${taskId ? `, taskId: ${JSON.stringify(taskId)}` : ''} } })`);
}

export default async (s) => {
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1 && ${state}.boards.some((b) => b.kind === 'quick')`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  const boardId = await s.eval(`${state}.boards.find((b) => b.kind === 'quick').id`);
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(boardId)}, title: 'Ship the PR link' })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Ship the PR link')`);
  const taskId = await s.eval(`${state}.tasks.find((t) => t.title === 'Ship the PR link').id`);
  await s.eval(`__office.store.setState({ tasks: ${state}.tasks.map((t) => t.id === ${JSON.stringify(taskId)} ? { ...t, git: { branch: 'task/ship-the-pr-link', base: 'main', pr: ${JSON.stringify(PR)} } } : t) })`);
  await s.resize(1440, 900);

  // From the card.
  await openBoard(s, blockId);
  await s.waitFor(`!!document.querySelector('.tb-card[data-task-id=${JSON.stringify(taskId)}] [data-testid=card-pr]')`);
  assert((await seat(s)).computerState !== 'seated', 'before the click the owner is not at the computer');
  await s.sleep(600);
  const card = await s.center(`.tb-card[data-task-id=${JSON.stringify(taskId)}] [data-testid=card-pr]`, '#42');
  assert(card, 'the card shows the pull request chip #42');
  const onTop = await s.eval(`document.elementFromPoint(${card.x}, ${card.y})?.closest('[data-testid=card-pr]') !== null`);
  assert(onTop, `the chip is on top at ${card.x.toFixed(0)},${card.y.toFixed(0)}`);
  await s.click(card.x, card.y);
  await s.waitFor(`${state}.computerState === 'seated'`, 5000);
  const atMac = await seat(s);
  assert(atMac.computerView === 'mirror' && atMac.portalMode && atMac.modal === null, `a click on the card's #42 sits the owner at the Mac in the live mirror, task board closed (${JSON.stringify(atMac)})`);
  await s.waitFor(`!!document.querySelector('.mac-portal')`, 5000);
  for (let i = 0; i < 20 && !opened(s); i++) await s.sleep(100);
  assert(opened(s).includes(`[portal] open ${PR.url}`), `and the Mac's browser is told to open ${PR.url}`);
  await s.shot('pr-computer-mirror');
  assert(await s.eval(`location.protocol === 'file:'`), 'the office window itself did not navigate away');

  await s.press('KeyF', 'f');
  await s.waitFor(`${state}.computerState === 'away'`, 5000);
  assert(!(await seat(s)).portalMode, 'F stands the owner back up');

  // From the task's detail.
  s.mainLogs.length = 0;
  await openBoard(s, blockId, taskId);
  await s.waitFor(`!!document.querySelector('[data-testid=task-detail] [data-testid=task-pr-link]')`);
  await s.sleep(400);
  const link = await s.center('[data-testid=task-detail] [data-testid=task-pr-link]', '#42');
  const top = await s.eval(`document.elementFromPoint(${link.x}, ${link.y})?.closest('[data-testid=task-pr-link]') !== null`);
  assert(top, `the detail's #42 link is on top at ${link.x.toFixed(0)},${link.y.toFixed(0)}`);
  await s.click(link.x, link.y);
  await s.waitFor(`${state}.computerState === 'seated'`, 5000);
  const again = await seat(s);
  assert(again.computerView === 'mirror' && again.modal === null, `a click on #42 in the task's detail does the same (${JSON.stringify(again)})`);
  for (let i = 0; i < 20 && !opened(s); i++) await s.sleep(100);
  assert(opened(s).includes(`[portal] open ${PR.url}`), 'and opens the same pull request');
  assert(opened(s).split('\n').length === 1, 'once');
};
