// Pictures of a task card held over a desk, over an empty desk, and of the hire panel that dropping it there opens, at
// 1440x900, for the Sims 4 placement comparison. Real hires and real mouse events, but no agent runs: nobody is assigned.
// Writes carry.png, empty.png and hire.png to OFFICE_SHOTS_DIR (default: the game program's shots/t3 folder).
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/shots-drag-desk.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const OUT = process.env.OFFICE_SHOTS_DIR ?? join(homedir(), '.claude/orchestrate/online-office-game/shots/t3');
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };
const state = '__office.store.getState()';

export default async (s) => {
  await s.resize(1440, 900);
  await s.waitFor('!!window.__office && !!window.office');
  const send = (m) => s.eval(`window.office.send(${JSON.stringify(m)})`);
  await send({ type: 'create_block', cwd: repo, name: 'Checkout' });
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const block = await s.eval(`${state}.company.blocks[0].id`);
  for (const [name, role] of [['Pia', 'orchestrator'], ['Ana', 'employee'], ['Cleo', 'employee'], ['Dev', 'employee']]) await send({ type: 'hire', provider: 'claude-code', blockId: block, name, role });
  await s.waitFor(`${state}.company.employees.length === 4`);
  await s.eval('__office.step(40)');
  const quick = await s.eval(`${state}.boards[0].id`);
  for (const title of ['Fix the login redirect', 'Add CSV export', 'Draft the release notes']) await send({ type: 'create_task', boardId: quick, title });
  await s.waitFor(`${state}.tasks.length === 3`);
  await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  // Stand in front of the pod, zoomed in a step, with the side chat closed so the desks have the screen.
  await s.eval('__office.teleport(-12.5, -0.8); __office.step(1)');
  await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true }))`);
  await s.sleep(1800);
  await s.eval('__office.set({ selectedId: null })');
  const deskAt = (id) =>
    s.eval(`(() => { const it = ${state}.building.stories[0].items.find((i) => i.id === ${JSON.stringify(id)}); const f = it.rot % 2 === 0 ? [3, 2] : [2, 3]; return __office.project((it.x + f[0] / 2) / 2, 0.75, (it.z + f[1] / 2) / 2); })()`);
  const ana = await s.eval(`${state}.company.employees.find((e) => e.name === 'Ana').seat`);
  const empty = `${block}:bench_desk:05`;

  async function save(name) {
    const path = await s.shot(name);
    mkdirSync(OUT, { recursive: true });
    copyFileSync(path, join(OUT, `${name}.png`));
  }

  await s.clickOn('[data-testid=tasks-chip]');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  await s.sleep(400);
  const card = await s.center('.tb-card', 'Fix the login');
  await s.mouse('mouseMoved', card.x, card.y);
  await s.mouse('mousePressed', card.x, card.y, 1);
  await s.mouse('mouseMoved', card.x + 8, card.y - 12, 1);
  for (let i = 1; i <= 8; i++) await s.mouse('mouseMoved', card.x + 8, card.y - 12 - (i * (card.y - 12 - 60)) / 8, 1);
  await s.waitFor("!!document.querySelector('.scrim.tb-away')");

  const hover = async (id, want) => {
    const p = await deskAt(id);
    await s.mouse('mouseMoved', p.x - 16, p.y - 10, 1);
    await s.mouse('mouseMoved', p.x, p.y, 1);
    await s.waitFor(want);
    await s.sleep(500);
    return p;
  };
  await hover(ana, `${state}.aim?.verdict.kind === 'assign'`);
  await save('carry');
  const at = await hover(empty, `${state}.aim?.verdict.kind === 'hire'`);
  await save('empty');
  await s.mouse('mouseReleased', at.x, at.y);
  await s.waitFor("!!document.querySelector('[data-testid=hire-for]')");
  await s.sleep(600);
  await save('hire');
  assert(await s.eval("document.querySelector('[data-testid=hire-for-desk]').innerText === 'Desk 6'"), 'the hire panel is the one for the empty desk');
};
