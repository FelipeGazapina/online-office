// What the owner controls about a Linear board, driven through the board UI with real mouse and key events and read back from
// the snapshot, against the fake Linear in fake-linear.ts: who the issues are assigned to (the owner, a picked person), the
// current cycle, the limit, hiding Done so its issues are never pulled and the limit goes to the open columns, showing it
// again, and all of it surviving a restart. What each filter must return is worked out here from the raw issues.
// Shared by e2e-board-ui.mjs (at its end) and e2e-board-linear.mjs (on its own, with no agent runs).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert } from './lib.mjs';
import { ME } from './fake-linear.ts';

const state = '__office.store.getState()';
const CLOSED = new Set(['Done', 'Canceled', 'Duplicate']);
// The four columns of the board, as the statuses of the fake map into them.
const columnOf = (status) => (CLOSED.has(status) ? 'done' : status === 'In Progress' ? 'doing' : status === 'In Review' ? 'review' : 'todo');

export async function linearBoardFlow(s, { fake, world, launch, env, afterRestart }) {
  const recent = [...world.issues].sort((a, b) => b.updatedAt - a.updatedAt);
  const want = (match, limit) => recent.filter(match).slice(0, limit);
  const idents = (rows) => rows.map((i) => i.identifier).sort();
  const open = (i) => !CLOSED.has(i.status.name);
  const mine = (i) => i.assignee === ME.id;
  const ana = (i) => i.assignee === 'u-ana';
  const current = (i) => i.cycle === 'cy-7';
  const columnCounts = (rows) => ['todo', 'doing', 'review', 'done'].map((c) => `${c}:${rows.filter((i) => columnOf(i.status.name) === c).length}`).join();

  const tap = () => s.eval(`if (!window.__sent) { window.__sent = []; __office.tapSend((m) => { window.__sent.push(m); window.office.send(m); }); }`);
  const sentCount = () => s.eval('window.__sent.length');
  const sentSince = (n) => s.eval(`window.__sent.slice(${n})`);
  const board = () => s.eval(`${state}.boards.find((b) => b.name === 'Linear')`);
  const onBoard = (id) => s.eval(`${state}.tasks.filter((t) => t.boardId === ${JSON.stringify(id)}).map((t) => t.origin.identifier).sort()`);
  const syncedAt = (id) => s.eval(`${state}.boardSync[${JSON.stringify(id)}]?.lastFetchedAt ?? 0`);
  const settled = (id, after) => s.waitFor(`${state}.boardSync[${JSON.stringify(id)}]?.kind === 'ready' && ${state}.boardSync[${JSON.stringify(id)}].lastFetchedAt > ${after}`, 30000);
  const radio = (label) => `(() => [...document.querySelectorAll('[data-testid=linear-filters] [role=radio]')].find((b) => b.innerText.trim() === ${JSON.stringify(label)}))()`;
  const checked = () => s.eval("[...document.querySelectorAll('[data-testid=linear-filters] [role=radio][aria-checked=true]')].map((b) => b.innerText.trim()).join('|')");
  const pick = async (label) => {
    await s.waitFor(`!!${radio(label)}`);
    const at = await s.eval(`(() => { const r = ${radio(label)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await s.click(at.x, at.y);
  };
  const saveAndSync = async (id) => {
    const before = await syncedAt(id);
    const mark = await sentCount();
    await s.waitFor("!document.querySelector('.tb-settings .tb-btn.primary').disabled");
    await s.clickOn('.tb-settings .tb-btn.primary', 'Save and sync');
    await settled(id, before);
    return (await sentSince(mark)).filter((m) => m.type === 'update_board');
  };
  const lastIssuesCall = () => fake.calls.filter((c) => c.tool === 'list_issues').at(-1)?.args;
  const shot = async (name) => {
    const path = await s.shot(name);
    if (process.env.OFFICE_SHOTS_DIR) {
      mkdirSync(process.env.OFFICE_SHOTS_DIR, { recursive: true });
      copyFileSync(path, join(process.env.OFFICE_SHOTS_DIR, `${name}.png`));
    }
  };

  await tap();

  // ── a Linear board, set up from the board ──
  await s.clickOn('[aria-label="New board"]');
  await s.waitFor("!!document.querySelector('.tb-newboard')");
  await s.type('Linear');
  await s.clickOn('.tb-kindcard[data-kind=feature]');
  await s.clickOn('.tb-newboard button[type=submit]');
  await s.waitFor(`${state}.boards.some((b) => b.name === 'Linear')`);
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Linear')");
  await s.clickOn('[data-testid=no-sources] button');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await s.clickOn('.tb-settings .tb-btn', 'Linear');
  await s.waitFor("!!document.querySelector('.tb-source input')");
  await s.clickOn('.tb-source input[aria-label=Project]');
  await s.type('team:BLOOM');
  assert((await checked()) === 'Anyone|Any|50 issues', 'a new Linear source starts on anyone, any cycle and 50 issues');
  const { id } = await board();
  const [firstSave] = await saveAndSync(id);
  assert(JSON.stringify(firstSave.sources) === JSON.stringify([{ provider: 'linear', projectId: 'team:BLOOM' }]) && !('collapsed' in firstSave), 'saving sends the source with no filters at all: the defaults are not a setting');
  const baseline = want(() => true, 50);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(baseline)), 'the board holds the 50 most recent issues, what the board always pulled');
  assert(JSON.stringify(lastIssuesCall()) === JSON.stringify({ team: 'BLOOM', limit: 50 }), 'from one call that names the team and the limit', JSON.stringify(lastIssuesCall()));

  // ── whose issues ──
  await pick('Me');
  await pick('200 issues');
  assert((await checked()) === 'Me|Any|200 issues', 'the segments show what was picked');
  const [meSave] = await saveAndSync(id);
  assert(JSON.stringify(meSave.sources[0].filters) === JSON.stringify({ assignee: 'me', cycle: 'any', limit: 200 }), 'the filters travel with the source', JSON.stringify(meSave.sources));
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(want(mine, 200))) && (await onBoard(id)).length === 51, 'Me brings only the owner\'s 51 issues, all of them, because the limit is 200');
  assert(lastIssuesCall().assignee === 'me' && lastIssuesCall().limit === 200, 'Linear was asked for "me" and 200');

  const usersBefore = fake.calls.filter((c) => c.tool === 'list_users').length;
  await s.clickOn('[data-testid=pick-person]');
  await s.waitFor("document.querySelectorAll('[role=listbox][aria-label=\"People in Linear\"] [role=option]').length === 70");
  assert(fake.calls.filter((c) => c.tool === 'list_users').length === usersBefore + 1, 'picking someone asks Linear for its people, once, and lists all 70');
  await s.clickOn('input[aria-label="Find a person"]');
  await s.type('Ana');
  await s.waitFor("document.querySelectorAll('[role=listbox][aria-label=\"People in Linear\"] [role=option]').length === 1");
  await s.clickOn('[role=listbox][aria-label="People in Linear"] [role=option]', 'Ana');
  await s.waitFor("!document.querySelector('[data-testid=people-pick]')");
  assert((await checked()) === 'Ana|Any|200 issues', 'the person picked shows on the assignee control');
  const [anaSave] = await saveAndSync(id);
  assert(JSON.stringify(anaSave.sources[0].filters.assignee) === JSON.stringify({ id: 'u-ana', name: 'Ana' }), 'the person is sent with the id and the name');
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(want(ana, 200))) && lastIssuesCall().assignee === 'u-ana', 'a picked person brings only their issues, asked by id');

  // ── which cycle ──
  await pick('Anyone');
  await pick('Current cycle');
  await saveAndSync(id);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(want(current, 200))) && (await onBoard(id)).length === 150, 'the current cycle brings only its 150 issues');
  const cycleCalls = fake.calls.filter((c) => ['list_cycles', 'list_issues'].includes(c.tool)).slice(-2);
  assert(cycleCalls[0].tool === 'list_cycles' && cycleCalls[0].args.type === 'current' && cycleCalls[1].args.cycle === 'cy-7', 'the team\'s current cycle was looked up and its id used');

  await s.clickOn('[data-testid=pick-person]');
  await s.waitFor("!!document.querySelector('[data-testid=people-pick] [role=option]')");
  await s.clickOn('[role=listbox][aria-label="People in Linear"] [role=option]', 'Ana');
  await saveAndSync(id);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(want((i) => ana(i) && current(i), 200))), 'a person and the current cycle together bring only what is both');
  await s.eval('document.activeElement?.blur()');
  await shot('filters');

  // ── back to the defaults ──
  await pick('Anyone');
  await pick('Any');
  await pick('50 issues');
  const [resetSave] = await saveAndSync(id);
  assert(!('filters' in resetSave.sources[0]) && JSON.stringify(await onBoard(id)) === JSON.stringify(idents(baseline)), 'set back to the defaults the filters are gone and the board is what it was');

  // ── hide a column: nothing is pulled for it, and its share of the limit goes to the open ones ──
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=board-settings]')");
  assert(baseline.filter((i) => CLOSED.has(i.status.name)).length === 22 && (await s.eval("document.querySelector('.tb-col[data-stage=done]').querySelectorAll('.tb-card').length")) === 22, 'with every column open, 22 of the 50 are in Done');
  const beforeHide = await syncedAt(id);
  const mark = await sentCount();
  const callsBefore = fake.calls.length;
  await s.clickOn('[aria-label="Hide Done"]');
  await s.waitFor("!!document.querySelector('[data-testid=hidden-columns]')");
  await settled(id, beforeHide);
  const hide = (await sentSince(mark)).filter((m) => m.type === 'update_board');
  assert(hide.length === 1 && JSON.stringify(hide[0]) === JSON.stringify({ type: 'update_board', boardId: id, collapsed: ['done'] }), 'Hide sends the folded column and nothing else');
  const openFifty = want(open, 50);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(openFifty)), 'the board now holds the 50 most recent open issues: Done is not pulled and the limit went to the others');
  const shown = await s.eval("[...document.querySelectorAll('.tb-col')].map((c) => `${c.dataset.stage}:${c.querySelectorAll('.tb-card').length}`).join()");
  assert(shown === columnCounts(openFifty).replace(/,done:0$/, ''), `the open columns hold ${shown}`, shown);
  assert(!(await s.eval("!!document.querySelector('.tb-col[data-stage=done]')")), 'the Done column is gone from the board');
  assert((await s.eval("document.querySelector('[data-testid=hidden-columns]').innerText.replace(/\\s+/g, ' ')")).startsWith('Hidden columns Done 0'), 'and listed under Hidden columns with its count');
  const hidePages = fake.calls.slice(callsBefore).filter((c) => c.tool === 'list_issues');
  assert(hidePages.length === 2 && hidePages.every((c) => c.args.limit === 50) && hidePages[1].args.cursor === 'c:50', 'it took a second page of Linear to find 50 open issues', JSON.stringify(hidePages.map((c) => c.args)));
  assert(await s.eval("document.querySelector('[aria-label=\"Hide Todo\"]') !== null"), 'the other columns can still be hidden');
  await s.eval('document.activeElement?.blur()');
  await shot('collapsed');

  // ── show it again ──
  const beforeShow = await syncedAt(id);
  await s.clickOn('.tb-hidden-row[data-stage=done]');
  await settled(id, beforeShow);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(baseline)) && !(await s.eval("!!document.querySelector('[data-testid=hidden-columns]')")), 'showing Done pulls its issues back on the next sync, and the rail goes');
  assert((await s.eval("document.querySelector('.tb-col[data-stage=done]').querySelectorAll('.tb-card').length")) === 22, 'Done holds its 22 again');

  // ── all of it survives a restart ──
  await s.clickOn('[aria-label="Board settings"]');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await pick('Me');
  await pick('200 issues');
  await saveAndSync(id);
  await s.press('Escape');
  const beforeFold = await syncedAt(id);
  await s.clickOn('[aria-label="Hide Done"]');
  await settled(id, beforeFold);
  assert(JSON.stringify(await onBoard(id)) === JSON.stringify(idents(want((i) => mine(i) && open(i), 200))), 'Me with Done hidden brings the owner\'s open issues');
  await s.sleep(500);
  await s.close();
  const again = await launch({ env });
  await again.waitFor('!!window.__office && !!window.office');
  await again.resize(1440, 900);
  await again.waitFor(`${state}.boards.some((b) => b.name === 'Linear')`, 30000);
  const kept = await again.eval(`${state}.boards.find((b) => b.name === 'Linear')`);
  assert(JSON.stringify(kept.collapsed) === '["done"]' && JSON.stringify(kept.sources[0].filters) === JSON.stringify({ assignee: 'me', cycle: 'any', limit: 200 }), 'the hidden column and the filters were still there after the restart', JSON.stringify(kept));
  await again.waitFor(`${state}.boardSync[${JSON.stringify(kept.id)}]?.kind === 'ready'`, 30000);
  assert(JSON.stringify(await again.eval(`${state}.tasks.filter((t) => t.boardId === ${JSON.stringify(kept.id)}).map((t) => t.origin.identifier).sort()`)) === JSON.stringify(idents(want((i) => mine(i) && open(i), 200))), 'and the first sync after it pulled with them: the owner\'s open issues, none from Done');
  await again.clickOn('[data-testid=tasks-chip]');
  await again.waitFor("!!document.querySelector('[data-testid=task-board]')");
  await again.clickOn('[role=tab]', 'Linear');
  await again.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Linear')");
  assert(await again.eval("!!document.querySelector('[data-testid=hidden-columns] .tb-hidden-row[data-stage=done]') && !document.querySelector('.tb-col[data-stage=done]')"), 'the board opens with Done under Hidden columns');
  await again.clickOn('[aria-label="Board settings"]');
  await again.waitFor("!!document.querySelector('[data-testid=linear-filters]')");
  assert((await again.eval("[...document.querySelectorAll('[data-testid=linear-filters] [role=radio][aria-checked=true]')].map((b) => b.innerText.trim()).join('|')")) === 'Me|Any|200 issues', 'and its settings show Me and 200 issues');
  await again.press('Escape');
  await afterRestart?.(again);
  return again;
}
