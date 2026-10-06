// Dragging a task card from the board onto a desk of the 3D office, driven the way the owner does it: real mouse and key
// events through CDP, every claim read from the store's snapshot, the page or mail.jsonl. Real haiku agents.
//   a card pulled out of the columns folds the board away, the desk under the pointer lights up with who sits there (or
//   "Empty desk: hire", or why it is refused), Esc and open floor change nothing, a desk of another block is refused,
//   a drop on the tray moves the stage, a drop on an employee's desk assigns once and they react within 2 s, a drop on the
//   PO's desk (in first person) assigns the PO who delegates, and a drop on an empty desk opens the hire panel for that
//   block and desk, whose Hire seats the new employee there and starts the task.
//   While the card is carried it never covers a name tag (screen rectangles of the card, its line and every tag showing),
//   and the bar at the bottom says what letting go does for each target: give it to Ana, hire for this desk, move to a
//   stage, or why it is refused. After a drop on a person the board stays folded as a tray of the cards still waiting, and
//   three cards go to three people in a row from it, without opening the board, each run started.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-drag-desk.mjs
// OFFICE_DRAG_WAIT_MIN caps each run of an agent (default 6).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryClearance } from './carry-rects.mjs';
import { HAIKU, assert } from './lib.mjs';

const WAIT_MS = Number(process.env.OFFICE_DRAG_WAIT_MIN ?? 6) * 60_000;
const REACT_MS = 2000;

const dataDir = mkdtempSync(join(tmpdir(), 't3-data-'));
const repoOf = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 't3-repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
};
const repoA = repoOf();
const repoB = repoOf();

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_CLAUDE_MODEL: HAIKU };

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
const requestsTo = (who) => ledger().flatMap((e) => (e.t === 'post' && e.msg.kind === 'request' && e.msg.to === who ? [e.msg] : []));
const taskBy = (title) => `${state}.tasks.find((t) => t.title === ${JSON.stringify(title)})`;

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks.map((t) => ({ title: t.title, stage: t.stage, assignees: t.assignees, runs: t.runs.length }))`).catch(() => '?')));
  console.log('modal:', JSON.stringify(await s.eval(`${state}.modal`).catch(() => '?')), 'aim:', JSON.stringify(await s.eval(`${state}.aim`).catch(() => '?')));
  console.log('sent at failure:', JSON.stringify(await s.eval('window.__sent?.slice(-10)').catch(() => '?')));
  console.log('ledger posts:\n' + ledger().filter((e) => e.t === 'post').slice(-10).map((e) => `${e.msg.kind} ${e.msg.from}->${e.msg.to} ${(e.msg.title ?? e.msg.text ?? '').slice(0, 80)}`).join('\n'));
  await s.shot('t3-failure').catch(() => {});
};

// Nobody is at the keyboard, so every employee runs in yolo mode and a permission card raised before the switch is answered.
async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

async function inReview(s, title, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    const t = await s.eval(`(() => { const t = ${taskBy(title)}; return { stage: t.stage, out: t.lastOutcome?.outcome, running: ${state}.taskTime[t.id]?.running.length ?? 0 }; })()`);
    if (t.stage === 'review' && t.out === 'done') return t;
    if (t.stage === 'todo' && t.out) throw new Error(`${label}: the task went back to todo (${t.out})`);
    await s.sleep(2500);
  }
  throw new Error(`${label}: not in review after ${Math.round(WAIT_MS / 1000)} s`);
}

const deliverable = (file, line) => `Create a file named ${file} in the project folder whose only line is: ${line}. Then reply done naming the file. Do not hire anyone.`;
const delegated = (file, line, to) =>
  `One deliverable and no acceptance bar. Send it to ${to} as one plain request, not a gauntlet, and do not hire anyone. The deliverable is a file named ${file} in the project folder whose only line is: ${line}. When ${to} replies done, check the file exists and reply done to the owner naming ${file}.`;

export default async (s) => {
  await s.resize(1440, 900);
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval('window.__sent = []; __office.tapSend((m) => { window.__sent.push(m); window.office.send(m); })');
  const sentOf = (...types) => s.eval(`window.__sent.filter((m) => ${JSON.stringify(types)}.includes(m.type))`);
  const sentCount = async () => (await s.eval('window.__sent.length'));
  const send = (m) => s.eval(`window.office.send(${JSON.stringify(m)})`);
  await send({ type: 'create_block', cwd: repoA, name: 'Checkout' });
  await s.waitFor(`${state}.company.blocks.length === 1`);
  await send({ type: 'create_block', cwd: repoB, name: 'Billing' });
  await s.waitFor(`${state}.company.blocks.length === 2`);
  const [checkout, billing] = await s.eval(`${state}.company.blocks.map((b) => b.id)`);
  await send({ type: 'hire', provider: 'claude-code', blockId: checkout, name: 'Pia', role: 'orchestrator' });
  await send({ type: 'hire', provider: 'claude-code', blockId: checkout, name: 'Ana' });
  await send({ type: 'hire', provider: 'claude-code', blockId: billing, name: 'Bruno' });
  await s.waitFor(`${state}.company.employees.length === 3`);
  await s.eval('__office.step(40)');
  await unattended(s);
  const person = (name) => s.eval(`${state}.company.employees.find((e) => e.name === ${JSON.stringify(name)})`);
  const [pia, ana, bruno] = [await person('Pia'), await person('Ana'), await person('Bruno')];
  const emptyDesk = `${checkout}:bench_desk:05`;
  assert(ana.seat === `${checkout}:bench_desk:00` && pia.seat === `${checkout}:po_desk:00` && bruno.seat === `${billing}:bench_desk:00`, 'the people sit at the first desks of their own blocks');
  assert(await s.eval(`!${state}.company.employees.some((e) => e.seat === ${JSON.stringify(emptyDesk)})`), 'the last bench desk of Checkout is empty');
  const quick = await s.eval(`${state}.boards.find((b) => b.blockId === ${JSON.stringify(checkout)}).id`);
  const titles = { ana: 'Add ana.txt', po: 'Add po.txt', hire: 'Add hire.txt', cross: 'Rename the staging bucket', floor: 'Draft the release notes', esc: 'Audit the unused flags', tray: 'Book the demo room' };
  const notes = { ana: `First run the shell command sleep 15, then ${deliverable('ana.txt', 'hello from ana').replace(/^Create/, 'create')}`, po: delegated('po.txt', 'hello from the po', 'Ana'), hire: deliverable('hire.txt', 'hello from the new hire') };
  for (const [key, title] of Object.entries(titles)) await send({ type: 'create_task', boardId: quick, title, ...(notes[key] ? { notes: notes[key] } : {}) });
  await s.waitFor(`${state}.tasks.length === ${Object.keys(titles).length}`);
  const task = (key) => s.eval(`${taskBy(titles[key])}`);
  // The owner stands at the front of the pods, where both blocks' desks are in view and nobody is within earshot.
  const still = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const c = await s.eval('({ x: __officeCamera.x, y: __officeCamera.y, z: __officeCamera.z, blend: __officeCamera.blend })');
      if (last && Math.hypot(c.x - last.x, c.y - last.y, c.z - last.z) < 0.005) return c;
      last = c;
      await s.sleep(250);
    }
    throw new Error('the camera never came to rest');
  };
  const standAt = async (x, z, yaw) => {
    await s.eval(`__office.teleport(${x}, ${z}${yaw === undefined ? '' : `, ${yaw}`}); __office.step(1)`);
    return still();
  };
  await standAt(-4, 1.5);
  const deskAt = (id) =>
    s.eval(`(() => { const it = ${state}.building.stories[0].items.find((i) => i.id === ${JSON.stringify(id)}); const f = it.rot % 2 === 0 ? [3, 2] : [2, 3]; return __office.project((it.x + f[0] / 2) / 2, 0.75, (it.z + f[1] / 2) / 2); })()`);
  const floorAt = () => s.eval('__office.project(-4, 0, 3.5)');
  const aim = () => s.eval(`${state}.aim`);
  const aimWord = () => s.eval("document.querySelector('[data-testid=desk-aim]')?.innerText ?? null");
  const chip = () => s.eval("document.querySelector('[data-testid=ghost-aim]')?.innerText ?? null");
  const bar = () => s.eval("(() => { const b = document.querySelector('[data-testid=carry-bar]'); return b ? { text: b.innerText.replace(/\\s+/g, ' ').trim(), tone: b.dataset.tone } : null; })()");
  const barIs = async (tone, pattern, label) => {
    const b = await bar();
    assert(!!b && b.tone === tone && pattern.test(b.text), `${label}: the bar says "${b?.text}" (${b?.tone})`);
    return b;
  };
  const clear = async (p, label, minTags = 2) => {
    const c = await carryClearance(s, p);
    assert(c.covered.length === 0 && c.tags >= minTags, `${label}: the card and its line cover none of ${c.tags} name tags, ${c.away} px from the pointer${c.covered.length ? ` (covers ${c.covered.join(' | ')})` : ''}`);
    return c;
  };
  const onScreen = (p) => p.x > 8 && p.x < 1432 && p.y > 8 && p.y < 892;
  for (const [name, id] of [['Ana', ana.seat], ['Pia', pia.seat], ['the empty desk', emptyDesk], ['Bruno', bruno.seat]]) assert(onScreen(await deskAt(id)), `${name}'s desk is on screen at 1440x900`);
  const openBoard = async () => {
    if (await s.eval("!!document.querySelector('[data-testid=task-board]') && !document.querySelector('.scrim.tb-away')")) return;
    if (await s.eval("!!document.querySelector('[data-testid=tray-open]')")) await s.clickOn('[data-testid=tray-open]');
    else await s.clickOn('[data-testid=tasks-chip]');
    await s.waitFor("!!document.querySelector('[data-testid=task-board]') && !document.querySelector('.scrim.tb-away')");
    await s.sleep(250);
  };
  const columnsAt = () => s.eval("(() => { const r = document.querySelector('[data-testid=task-board-columns]').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()");
  // Presses on the card and takes it out of the columns, over the title strip of the board.
  const pickUp = async (title) => {
    await openBoard();
    const card = await s.center('.tb-card', title);
    if (!card) throw new Error(`no card for ${title}`);
    await s.mouse('mouseMoved', card.x, card.y);
    await s.mouse('mousePressed', card.x, card.y, 1);
    await s.mouse('mouseMoved', card.x + 6, card.y - 10, 1);
    await s.mouse('mouseMoved', card.x + 12, card.y - 30, 1);
    await s.waitFor("!!document.querySelector('.tb-ghost')");
    const cols = await columnsAt();
    for (let i = 1; i <= 6; i++) await s.mouse('mouseMoved', card.x + 12, card.y - 30 - ((card.y - 30 - (cols.top - 40)) * i) / 6, 1);
    await s.waitFor("!!document.querySelector('.scrim.tb-away') && !!document.querySelector('[data-testid=carry-tray]')");
    return card;
  };
  const hover = async (p, want) => {
    await s.mouse('mouseMoved', p.x - 14, p.y - 9, 1);
    await s.mouse('mouseMoved', p.x, p.y, 1);
    if (want) await s.waitFor(want, 4000);
  };
  const boardBack = () => s.waitFor("!!document.querySelector('[data-testid=task-board]') && !document.querySelector('.scrim.tb-away') && !document.querySelector('[data-testid=carry-tray]') && !document.querySelector('.tb-ghost') && !document.body.classList.contains('tb-carrying-away') && !" + state + '.aim');
  const nothingSince = async (mark, label) => assert((await s.eval(`window.__sent.slice(${mark}).filter((m) => ['assign_task', 'hire', 'update_task', 'create_task'].includes(m.type))`)).length === 0, label);
  await openBoard();
  const first = await s.center('.tb-card', titles.esc);
  const doing = await s.center('.tb-col[data-stage="doing"] .tb-col-body');
  let mark = await sentCount();
  await s.mouse('mouseMoved', first.x, first.y);
  await s.mouse('mousePressed', first.x, first.y, 1);
  for (let i = 1; i <= 8; i++) await s.mouse('mouseMoved', first.x + ((doing.x - first.x) * i) / 8, first.y + ((doing.y - first.y) * i) / 8, 1);
  await s.waitFor("!!document.querySelector('.tb-col.over[data-stage=doing]')");
  assert(await s.eval("!document.querySelector('.scrim.tb-away') && !document.querySelector('[data-testid=carry-tray]')"), 'moving a card across the columns leaves the board where it is');
  await s.press('Escape');
  await boardBack();
  await nothingSince(mark, 'Esc over a column sends nothing');
  mark = await sentCount();
  await pickUp(titles.esc);
  const folded = await s.eval(`(() => { const scrim = document.querySelector('.scrim'); const modal = document.querySelector('.modal.tb'); return { bg: getComputedStyle(scrim).backgroundColor, blur: getComputedStyle(scrim).backdropFilter, opacity: getComputedStyle(modal).opacity, ptr: getComputedStyle(modal).pointerEvents, tray: [...document.querySelectorAll('[data-tray-stage]')].map((c) => c.dataset.trayStage).join(), ghost: document.querySelector('.tb-ghost').className }; })()`);
  await s.sleep(300);
  const settled = await s.eval("(() => { const m = document.querySelector('.modal.tb'); return { opacity: getComputedStyle(m).opacity, bg: getComputedStyle(document.querySelector('.scrim')).backgroundColor }; })()");
  assert(settled.opacity === '0' && folded.ptr === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(settled.bg) && (folded.blur === 'none' || folded.blur === ''), `the board folds away (opacity ${settled.opacity}, backdrop ${settled.bg}) so the office shows`);
  assert(folded.tray === 'todo,doing,review,done' && folded.ghost.includes('away'), 'the four stages stay as drop targets in the tray, and the card in hand shrinks to hang off the pointer');
  assert(await s.eval("document.elementFromPoint(720, 450)?.closest('.stage') !== null"), 'the pointer is over the office, not over the board');
  const anaAt = await deskAt(ana.seat);
  await hover(anaAt, `${state}.aim?.verdict.kind === 'assign'`);
  let a = await aim();
  assert(a.deskId === ana.seat && a.verdict.to.id === ana.id && !a.verdict.already, 'over Ana\'s desk the aim is an assignment to Ana');
  await s.waitFor("document.querySelector('[data-testid=desk-aim]')?.innerText.trim() === 'Ana'");
  assert((await chip()) === 'Give it to Ana', 'the desk says Ana and the card in hand says what letting go does');
  await barIs('go', /^Let go to give it to Ana\. Ana starts at once\./, 'over Ana');
  await clear(anaAt, 'over Ana', 4);
  const lit = await s.eval("__office.probe('desk-aim')");
  assert(lit.length === 1 && lit[0].desk === ana.seat && lit[0].tone === 'go' && lit[0].label === 'Ana', 'the 3D highlight sits on Ana\'s desk, green', JSON.stringify(lit));
  await hover(await deskAt(pia.seat), `${state}.aim?.deskId === ${JSON.stringify(pia.seat)}`);
  assert((await aim()).verdict.to.po === true && (await s.eval("document.querySelector('[data-testid=desk-aim]').innerText.trim()")) === 'Pia · PO', 'over the PO desk it names the PO');
  await barIs('go', /^Let go to give it to Pia, the PO\. Pia starts at once\./, 'over the PO desk');
  await clear(await deskAt(pia.seat), 'over the PO desk', 4);
  await hover(await deskAt(emptyDesk), `${state}.aim?.verdict.kind === 'hire'`);
  a = await aim();
  assert(a.deskId === emptyDesk && a.verdict.blockId === checkout && a.verdict.role === 'employee', 'over an empty desk the aim is a hire into that desk of this block');
  await s.waitFor("document.querySelector('[data-testid=desk-aim]')?.innerText.trim() === 'Empty desk: hire'");
  assert((await chip()) === 'Hire for this desk', 'the empty desk says "Empty desk: hire"');
  const emptyBar = await barIs('go', /^Empty desk\. Let go to hire someone for it, who starts this task\./, 'over the empty desk');
  assert(!/give it to|person there/.test(emptyBar.text), 'and it does not talk about a person there');
  await clear(await deskAt(emptyDesk), 'over the empty desk', 4);
  await hover(await deskAt(bruno.seat), `${state}.aim?.verdict.kind === 'refuse'`);
  const refusal = (await aim()).verdict.message;
  assert(/belongs to Billing/.test(refusal) && /own block, Checkout/.test(refusal), 'over a desk of another block the aim is a refusal that names both blocks', refusal);
  assert((await s.eval("__office.probe('desk-aim')"))[0]?.tone === 'stop' && (await chip()) === 'Not there', 'it is lit red and the card in hand says it cannot go there');
  assert((await bar()).tone === 'stop' && (await bar()).text.startsWith(refusal), 'the bar says why: ' + refusal);
  await clear(await deskAt(bruno.seat), 'over another block\'s desk', 4);
  await hover(await floorAt(), `${state}.aim === null`);
  assert((await s.eval("__office.probe('desk-aim').length")) === 0 && (await chip()) === 'Hold it over a desk', 'over open floor nothing is lit');
  await barIs('idle', /^Hold it over a desk to give it to the person there, or over a stage to move it\./, 'over open floor');
  await clear(await floorAt(), 'over open floor', 4);
  await hover(anaAt, `${state}.aim?.verdict.kind === 'assign'`);
  await s.press('Escape');
  await boardBack();
  await nothingSince(mark, 'Esc over a desk sends nothing');
  assert((await task('esc')).stage === 'todo' && (await task('esc')).runs.length === 0, 'and the card is where it was');
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'the board is open again after Esc');

  await pickUp(titles.floor);
  await hover(await floorAt(), `${state}.aim === null`);
  await s.mouse('mouseReleased', (await floorAt()).x, (await floorAt()).y);
  await boardBack();
  await nothingSince(mark, 'letting go over open floor sends nothing');
  assert((await task('floor')).stage === 'todo' && (await task('floor')).runs.length === 0, 'the card stays in Todo');

  await pickUp(titles.cross);
  const brunoAt = await deskAt(bruno.seat);
  await hover(brunoAt, `${state}.aim?.verdict.kind === 'refuse'`);
  await s.mouse('mouseReleased', brunoAt.x, brunoAt.y);
  await boardBack();
  await s.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('belongs to Billing'))`);
  await nothingSince(mark, 'a drop on a desk of another block sends nothing');
  assert((await task('cross')).stage === 'todo' && (await task('cross')).assignees.length === 0, 'the refused card stays in Todo with nobody on it');
  ok('the refusal is said in a toast: ' + (await s.eval("[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' / ')")));
  mark = await sentCount();
  await pickUp(titles.tray);
  const trayDoing = await s.center('[data-tray-stage=doing]');
  await s.mouse('mouseMoved', trayDoing.x - 20, trayDoing.y - 10, 1);
  await s.mouse('mouseMoved', trayDoing.x, trayDoing.y, 1);
  await s.waitFor("!!document.querySelector('[data-tray-stage=doing].over')");
  assert((await aim()) === null, 'over a tray chip there is no desk aim');
  await barIs('go', /^Let go to move it to In Progress\./, 'over the In Progress chip');
  assert((await chip()) === 'Move to In Progress', 'and the card in hand says the same');
  const trayTodo = await s.center('[data-tray-stage=todo]');
  await s.mouse('mouseMoved', trayTodo.x - 10, trayTodo.y - 4, 1);
  await s.mouse('mouseMoved', trayTodo.x, trayTodo.y, 1);
  await s.waitFor("document.querySelector('[data-testid=carry-bar]')?.dataset.tone === 'same'");
  await barIs('same', /^It is already in Todo\./, 'over the stage the card came from');
  await s.mouse('mouseMoved', trayDoing.x - 10, trayDoing.y - 4, 1);
  await s.mouse('mouseMoved', trayDoing.x, trayDoing.y, 1);
  await s.waitFor("!!document.querySelector('[data-tray-stage=doing].over')");
  await s.mouse('mouseReleased', trayDoing.x, trayDoing.y);
  await boardBack();
  const moves = await s.eval(`window.__sent.slice(${mark}).filter((m) => m.type === 'update_task')`);
  const tray = await task('tray');
  assert(moves.length === 1 && moves[0].stage === 'doing' && moves[0].taskId === tray.id && !(await sentOf('assign_task')).length, 'a drop on the In Progress chip sends one update_task and no assignment');
  await s.waitFor(`${taskBy(titles.tray)}.stage === 'doing'`);
  assert(await s.eval("!!document.querySelector('.tb-col[data-stage=doing] .tb-card')?.innerText.includes('Book the demo room')"), 'and the card shows in the In Progress column');
  mark = await sentCount();
  const anaTask = await task('ana');
  await pickUp(titles.ana);
  await hover(anaAt, `${state}.aim?.deskId === ${JSON.stringify(ana.seat)}`);
  await s.shot('t3-before-drop');
  await s.mouse('mouseReleased', anaAt.x, anaAt.y);
  const released = Date.now();
  await s.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('"Add ana.txt" goes to Ana'))`, 1500);
  ok('a toast says who has it');
  const assigns = async () => (await s.eval(`window.__sent.slice(${mark}).filter((m) => m.type === 'assign_task')`));
  // The bubble over the employee's head: the working line, or whatever they say.
  const bubble = (id) => `(() => { const l = document.querySelector('.emp-label[data-hud-resize-target="employee-label-${id}"]'); const b = l?.querySelector('.bub'); return !!b && getComputedStyle(l).visibility !== 'hidden' && (b.classList.contains('work') || b.classList.contains('said')); })()`;
  let reacted = null;
  while (Date.now() - released < 6000) {
    if (await s.eval(bubble(ana.id))) {
      reacted = Date.now() - released;
      break;
    }
    await s.sleep(50);
  }
  assert(reacted !== null && reacted <= REACT_MS, `Ana's bubble shows ${reacted} ms after the drop (limit ${REACT_MS} ms)`);
  const sentAssign = await assigns();
  assert(sentAssign.length === 1 && sentAssign[0].taskId === anaTask.id && sentAssign[0].employeeId === ana.id, 'the drop fires assign_task once, for Ana');
  await s.sleep(1500);
  assert((await assigns()).length === 1, 'and not again');
  await s.waitFor("!!document.querySelector('[data-testid=task-tray]')");
  assert(await s.eval(`${state}.modal?.kind === 'task_board' && ${state}.modal.tray === true && !document.querySelector('[data-testid=task-board]') && !document.querySelector('[data-testid=carry-tray]')`), 'the owner is back in the office and the board stays folded as a tray');
  const waiting = await s.eval("[...document.querySelectorAll('[data-testid=task-tray] .tb-card')].map((c) => c.querySelector('.tb-card-title').innerText)");
  assert(!waiting.includes(titles.ana) && waiting.includes(titles.po) && waiting.includes(titles.hire) && waiting.length === 5, 'the tray lists the cards still in Todo and not the one just handed over', waiting.join(' | '));
  assert(await s.eval("!!document.querySelector('[data-testid=tray-open]') && !!document.querySelector('[data-testid=tasks-chip]')"), 'and it says how to get the whole board back: an Open board button, and the Tasks chip still opens it');
  await s.waitFor(`${taskBy(titles.ana)}.stage === 'doing' && ${taskBy(titles.ana)}.assignees.includes(${JSON.stringify(ana.id)}) && ${taskBy(titles.ana)}.runs.length === 1`);
  const run = requestsTo(ana.id).find((m) => m.from === 'owner' && m.title === titles.ana);
  assert(!!run && run.intent === 'work' && (await task('ana')).runs[0] === run.id, 'mail.jsonl has one work request from the owner to Ana, and it is the task\'s run');
  await s.waitFor(`${state}.taskTime[${JSON.stringify(anaTask.id)}]?.running.some((r) => r.employeeId === ${JSON.stringify(ana.id)})`, 20000);
  await openBoard();
  const cardOf = "[...document.querySelectorAll('.tb-col[data-stage=doing] .tb-card')].find((c) => c.innerText.includes('Add ana.txt'))";
  assert(await s.eval(`!!${cardOf} && !!${cardOf}.querySelector('[data-employee="${ana.id}"]')`), 'the card is in In Progress with Ana\'s avatar on it');
  const ms = () => s.eval(`Number(${cardOf}?.querySelector('[data-testid=task-timer]')?.dataset.ms ?? -1)`);
  const t1 = await ms();
  await s.sleep(1500);
  const t2 = await ms();
  assert(t1 >= 0 && t2 >= t1 + 1000 && (await s.eval(`${cardOf}.querySelector('[data-testid=task-timer]').dataset.running`)) === 'true', `the card's timer ticks while she works (${t1} to ${t2} ms)`);
  mark = await sentCount();
  await pickUp(titles.ana);
  await hover(anaAt, `${state}.aim?.deskId === ${JSON.stringify(ana.seat)}`);
  assert((await aim()).verdict.already === true && (await s.eval("document.querySelector('[data-testid=desk-aim]').innerText.trim()")) === 'Ana is already on it' && (await s.eval("__office.probe('desk-aim')"))[0]?.tone === 'same', 'while Ana is on the task, her desk says so and lights amber');
  await barIs('same', /^Ana is already on it\. Letting go changes nothing\./, 'over Ana while she is on it');
  await s.mouse('mouseReleased', anaAt.x, anaAt.y);
  await boardBack();
  await nothingSince(mark, 'dropping the card on her again sends nothing');
  assert(await s.eval(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('already on'))`), 'and a toast says she is already on it');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-board]')");
  await s.eval("__office.set({ camera: 'first' })");
  await standAt(-9, 0.6, Math.PI);
  await s.waitFor('__officeCamera.blend === 1');
  const piaFp = await deskAt(pia.seat);
  assert(await s.eval('__office.state().camera') === 'first' && onScreen(piaFp), `first person looks at the pods and the PO's desk is on screen (${Math.round(piaFp.x)}, ${Math.round(piaFp.y)})`);
  mark = await sentCount();
  const poTask = await task('po');
  await pickUp(titles.po);
  await hover(piaFp, `${state}.aim?.deskId === ${JSON.stringify(pia.seat)}`);
  assert((await aim()).verdict.to.id === pia.id && (await s.eval("document.querySelector('[data-testid=desk-aim]').innerText.trim()")) === 'Pia · PO', 'in first person too, the PO\'s desk is the aim and says Pia');
  await barIs('go', /^Let go to give it to Pia, the PO\./, 'in first person over the PO desk');
  await clear(piaFp, 'in first person over the PO desk', 1);
  await s.mouse('mouseReleased', piaFp.x, piaFp.y);
  const poReleased = Date.now();
  let poReacted = null;
  while (Date.now() - poReleased < 6000) {
    if (await s.eval(bubble(pia.id))) {
      poReacted = Date.now() - poReleased;
      break;
    }
    await s.sleep(50);
  }
  assert(poReacted !== null && poReacted <= REACT_MS, `the PO's bubble shows ${poReacted} ms after the drop (limit ${REACT_MS} ms)`);
  const poAssigns = await s.eval(`window.__sent.slice(${mark}).filter((m) => m.type === 'assign_task')`);
  assert(poAssigns.length === 1 && poAssigns[0].taskId === poTask.id && poAssigns[0].employeeId === pia.id, 'one assign_task, for the PO');
  await s.eval("__office.set({ camera: 'iso' })");
  await standAt(-4, 1.5);
  await inReview(s, titles.ana, 'ana.txt');
  const ana1 = await task('ana');
  assert(ana1.lastOutcome.outcome === 'done' && ana1.assignees.length === 1 && ana1.runs.length === 1, 'Ana\'s task went to review on her one run');
  await inReview(s, titles.po, 'po.txt');
  const po1 = await task('po');
  const delegation = requestsTo(ana.id).find((m) => m.from === pia.id);
  assert(po1.assignees.length === 1 && po1.assignees[0] === pia.id && po1.runs.length === 1 && !!delegation, 'the PO\'s task went to review: Pia took it and delegated a piece to Ana, as usual');
  mark = await sentCount();
  const hireTask = await task('hire');
  await pickUp(titles.hire);
  const emptyAt = await deskAt(emptyDesk);
  await hover(emptyAt, `${state}.aim?.verdict.kind === 'hire'`);
  await s.mouse('mouseReleased', emptyAt.x, emptyAt.y);
  await s.waitFor("!!document.querySelector('[data-testid=hire-for]')");
  const panel = await s.eval("({ text: document.querySelector('[data-testid=hire-for]').innerText.replace(/\\s+/g, ' '), block: document.querySelector('[data-testid=hire-for-block]').innerText, desk: document.querySelector('[data-testid=hire-for-desk]').innerText, title: document.querySelector('.modal h2').innerText, hasBlockPicker: [...document.querySelectorAll('.modal .field span')].some((x) => x.innerText.trim() === 'Block' || x.innerText.trim() === 'Role') })");
  assert(panel.block === 'Checkout' && panel.desk === 'Desk 6' && panel.text.includes('Add hire.txt') && /Employee/.test(panel.text), `the hire panel is set to block Checkout, Desk 6 and the task (${panel.text})`);
  assert(!panel.hasBlockPicker, 'with the block and the role fixed there is nothing to pick for them');
  assert((await sentOf('hire')).length === 0 && (await s.eval(`${state}.company.employees.length`)) === 3, 'nothing is hired until the owner says so');
  await s.clickOn('.modal .btn', 'Cancel');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  await nothingSince(mark, 'Cancel sends nothing');
  assert((await task('hire')).stage === 'todo' && (await task('hire')).runs.length === 0 && (await s.eval(`${state}.company.employees.length`)) === 3, 'Cancel leaves the task in Todo and the desk empty, and the board is back');

  await pickUp(titles.hire);
  await hover(emptyAt, `${state}.aim?.verdict.kind === 'hire'`);
  await s.mouse('mouseReleased', emptyAt.x, emptyAt.y);
  await s.waitFor("!!document.querySelector('[data-testid=hire-for]')");
  await s.eval("document.querySelector('.modal input').focus()");
  await s.type('Cleo');
  await s.clickOn('.modal .btn.primary', 'Hire');
  await s.waitFor(`${state}.company.employees.some((e) => e.name === 'Cleo')`, 20000);
  await unattended(s);
  const cleo = await person('Cleo');
  const hires = await s.eval(`window.__sent.slice(${mark}).filter((m) => m.type === 'hire')`);
  assert(hires.length === 1 && hires[0].deskId === emptyDesk && hires[0].taskId === hireTask.id && hires[0].blockId === checkout && hires[0].role === 'employee', 'Hire sends one hire with the dropped desk, block and task');
  assert(cleo.seat === emptyDesk && cleo.blockId === checkout, 'the new employee is seated at that exact desk of Checkout');
  await s.waitFor(`${taskBy(titles.hire)}.runs.length === 1 && ${taskBy(titles.hire)}.assignees.includes(${JSON.stringify(cleo.id)}) && ${taskBy(titles.hire)}.stage === 'doing'`, 20000);
  const first1 = requestsTo(cleo.id)[0];
  assert(!!first1 && first1.from === 'owner' && first1.title === titles.hire && (await task('hire')).runs[0] === first1.id, 'their first request is the task, from the owner, and nothing else was needed');
  for (let i = 0; i < 30 && !(await s.eval(`__office.state().avatars.find((a) => a.id === ${JSON.stringify(cleo.id)})?.seated`)); i++) {
    await s.eval('__office.step(3)');
    await s.sleep(200);
  }
  assert(await s.eval(`__office.state().avatars.find((a) => a.id === ${JSON.stringify(cleo.id)})?.seated`), 'and they walked in and sat down');
  await inReview(s, titles.hire, 'hire.txt');
  const hire1 = await task('hire');
  assert(hire1.lastOutcome.outcome === 'done' && hire1.assignees.length === 1, 'the new hire finished the task on their first run');

  // Three cards to three people in a row. The board is opened once, for the first card. After it the board stays folded as a
  // tray, and the next two cards are picked from the tray and carried to their desks, with no trip back to the board.
  const rows = [
    { title: 'Add row1.txt', who: ana, file: 'row1.txt' },
    { title: 'Add row2.txt', who: cleo, file: 'row2.txt' },
    { title: 'Add row3.txt', who: pia, file: 'row3.txt' },
  ];
  for (const r of rows) await send({ type: 'create_task', boardId: quick, title: r.title, notes: deliverable(r.file, `hello from ${r.who.name}`) });
  await s.waitFor(`${state}.tasks.length === ${Object.keys(titles).length + rows.length}`);
  const inRow = (r) => s.eval(`${taskBy(r.title)}`);
  const rowIds = [];
  for (const r of rows) rowIds.push((await inRow(r)).id);
  const pickFromTray = async (title) => {
    const card = await s.eval(`(() => { const el = [...document.querySelectorAll('[data-testid=task-tray] .tb-card')].find((c) => c.innerText.includes(${JSON.stringify(title)})); if (!el) return null; el.scrollIntoView({ inline: 'nearest', block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!card) throw new Error(`no card for ${title} in the tray`);
    await s.mouse('mouseMoved', card.x, card.y);
    await s.mouse('mousePressed', card.x, card.y, 1);
    await s.mouse('mouseMoved', card.x + 4, card.y - 12, 1);
    await s.mouse('mouseMoved', card.x + 8, card.y - 40, 1);
    await s.waitFor("!!document.querySelector('.tb-ghost')");
    for (let i = 1; i <= 6; i++) await s.mouse('mouseMoved', card.x + 8, card.y - 40 - (i * 120) / 6, 1);
    await s.waitFor("!!document.querySelector('.scrim.tb-away') && !!document.querySelector('[data-testid=carry-tray]')");
  };
  await openBoard();
  await s.eval(`window.__modals = []; const kind = (m) => (m ? m.kind + (m.tray ? ':tray' : '') : 'none'); window.__modals.push(kind(${state}.modal)); __office.store.subscribe((st) => { const k = kind(st.modal); if (window.__modals.at(-1) !== k) window.__modals.push(k); })`);
  mark = await sentCount();
  const handed = [];
  for (const [i, r] of rows.entries()) {
    if (i === 0) await pickUp(r.title);
    else await pickFromTray(r.title);
    const at = await deskAt(r.who.seat);
    await hover(at, `${state}.aim?.deskId === ${JSON.stringify(r.who.seat)}`);
    await barIs('go', new RegExp(`^Let go to give it to ${r.who.name}`), `card ${i + 1} of 3 over ${r.who.name}`);
    await clear(at, `card ${i + 1} of 3 over ${r.who.name}`, 4);
    await s.mouse('mouseReleased', at.x, at.y);
    await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(rowIds[i])}).assignees.includes(${JSON.stringify(r.who.id)})`, 10000);
    await s.waitFor("!!document.querySelector('[data-testid=task-tray]') && !document.querySelector('[data-testid=carry-tray]') && !document.querySelector('.tb-ghost')");
    handed.push(r.title);
    const left = await s.eval("[...document.querySelectorAll('[data-testid=task-tray] .tb-card .tb-card-title')].map((e) => e.innerText)");
    assert(handed.every((t) => !left.includes(t)) && rows.slice(i + 1).every((n) => left.includes(n.title)), `after card ${i + 1} the tray lists what is left (${left.length} cards) and not what was handed over`);
  }
  const trail = await s.eval('window.__modals');
  assert(JSON.stringify(trail) === JSON.stringify(['task_board', 'task_board:tray']), `three cards went out without the board reopening: the dialog went board, then tray, and stayed there (${trail.join(' > ')})`);
  const trio = await s.eval(`window.__sent.slice(${mark}).filter((m) => m.type === 'assign_task')`);
  assert(trio.length === 3 && trio.every((m, i) => m.taskId === rowIds[i] && m.employeeId === rows[i].who.id), 'three assign_task messages left, one per card, each for its person');
  for (const [i, r] of rows.entries()) {
    await s.waitFor(`${taskBy(r.title)}.runs.length === 1 && ${taskBy(r.title)}.stage === 'doing' && ${state}.taskTime[${JSON.stringify(rowIds[i])}]?.running.some((x) => x.employeeId === ${JSON.stringify(r.who.id)})`, 30000);
    const req = requestsTo(r.who.id).find((m) => m.from === 'owner' && m.title === r.title);
    assert(!!req && req.intent === 'work' && (await inRow(r)).runs[0] === req.id, `${r.who.name}'s run of "${r.title}" started: one work request in mail.jsonl, and the clock is running`);
  }
  assert((await s.eval(`${state}.modal?.tray === true`)), 'and the tray is still up for the next card');
  // The keyboard way in: Enter on a card of the tray opens it in the whole board, where its detail has Assign.
  await s.eval(`[...document.querySelectorAll('[data-testid=task-tray] .tb-card')].find((c) => c.innerText.includes(${JSON.stringify(titles.esc)})).focus()`);
  await s.press('Enter');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]') && !!document.querySelector('[data-testid=task-detail]') && !document.querySelector('[data-testid=task-tray]')");
  assert(await s.eval(`${state}.modal?.kind === 'task_board' && !${state}.modal.tray && ${state}.modal.taskId === ${JSON.stringify((await task('esc')).id)} && [...document.querySelectorAll('[data-testid=task-detail] h3')].some((h) => h.innerText === 'Assign')`), 'Enter on a tray card opens the whole board on that task, with its Assign list');
  assert(await s.eval(`[...document.querySelectorAll('.tb-col[data-stage=doing] .tb-card')].filter((c) => ${JSON.stringify(rows.map((r) => r.title))}.some((t) => c.innerText.includes(t))).length === 3`), 'and the whole board has the three handed cards in In Progress');
  const assignAll = await sentOf('assign_task');
  assert(assignAll.length === 5 && assignAll.map((m) => m.employeeId).join() === [ana.id, pia.id, ana.id, cleo.id, pia.id].join(), 'over the whole run exactly five assign_task messages left the HUD: Ana, the PO, then the three of the row');
  assert((await s.eval(`${state}.tasks.filter((t) => ['${titles.cross}', '${titles.floor}', '${titles.esc}'].includes(t.title)).every((t) => t.stage === 'todo' && t.runs.length === 0 && t.assignees.length === 0)`)), 'the cards that were cancelled or refused are still untouched in Todo');

  // How the tray ends. Dropping on a person makes it (above); here it is put up directly to check the ways out.
  const foldTray = async () => {
    await s.eval(`__office.set({ modal: { kind: 'task_board', blockId: ${JSON.stringify(checkout)}, tray: true } })`);
    await s.waitFor("!!document.querySelector('[data-testid=task-tray]') && !document.querySelector('[data-testid=task-board]')");
  };
  await foldTray();
  await s.press('Escape');
  await s.waitFor(`!${state}.modal && !document.querySelector('[data-testid=task-tray]')`);
  ok('Esc closes the tray and gives the office its keys back');
  await foldTray();
  await s.clickOn('[data-testid=tray-close]');
  await s.waitFor(`!${state}.modal && !document.querySelector('[data-testid=task-tray]')`);
  ok('the close button closes the tray');
  await foldTray();
  await s.clickOn('[data-testid=tasks-chip]');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]') && !document.querySelector('[data-testid=task-tray]') && !document.querySelector('.scrim.tb-away')");
  assert(await s.eval(`!${state}.modal.tray`), 'the Tasks chip brings the whole board back from the tray');
  await foldTray();
  for (const key of ['esc', 'floor', 'cross']) await send({ type: 'update_task', taskId: (await task(key)).id, stage: 'review' });
  await s.waitFor(`!${state}.modal && !document.querySelector('[data-testid=task-tray]')`, 8000);
  ok('with nothing left in Todo the tray closes by itself');
};

const ok = (msg) => console.log('ok:', msg);

// After the driver has printed its diagnosis, which reads these folders.
process.on('exit', () => {
  for (const dir of [dataDir, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});
