// The terminal on an employee's monitor, with a real haiku employee. A task is assigned and, within 2 s of the turn starting, the
// monitor shows its prompt and then its tool calls as they happen. F at the desk flies the camera into the monitor and opens the
// terminal with its whole scrollback. A message typed there reaches the employee (the mail ledger holds the owner post, and they
// answer in the terminal). Esc stops a step and the turn ends interrupted. A permission card is answered in the terminal and
// releases the tool. Esc on an idle employee leaves, and the camera comes back.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-terminal.mjs
import { execFileSync } from 'node:child_process';
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
  console.log('panel at failure:\n' + ((await s.eval(`(document.querySelector('.term-scroll')?.innerText ?? '').split('\\n').slice(-30).join('\\n')`).catch(() => '')) || '(closed)'));
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
  const taskText = 'Create a file named hello.txt containing exactly the word hi with your Write tool. Then use your Bash tool to run the command ls. Then say done in one short sentence.';
  await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(id)}, clientId: 'task-1', as: 'request', text: ${JSON.stringify(taskText)} })`);
  await s.waitFor(`${state}.company.employees[0].status.kind === 'working'`, 20000);
  const turnStart = ledger().filter((e) => e.t === 'deliver' && e.to === id).at(-1)?.at ?? asked;
  const shown = await waitScreen(s, id, /Create a file named hello\.txt/, 8000, 'the prompt');
  const lag = Date.now() - turnStart;
  console.log(`the prompt reached the monitor ${lag} ms after the turn started`);
  assert(lag < 2000, `the prompt is on the monitor within 2 s of the turn starting (${lag} ms)`);
  const write = await waitScreen(s, id, /Write\(hello\.txt\)/, 40000, 'the write call');
  assert((await s.eval(`${state}.company.employees[0].status.kind`)) === 'working' || /Wrote/.test(text(write.rows)), 'the call shows while the employee is still at work');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);
  const done = await waitScreen(s, id, /hello\.txt/, 5000, 'the result');
  console.log(text(done.rows));
  await s.shot('terminal-monitor');

  // F at the desk: the camera flies into the monitor and the terminal opens over it, with everything that was printed.
  const monitor = (await s.eval('__officeMonitors()'))[id];
  const away = (cam) => Math.hypot(cam.x - monitor.center[0], cam.y - monitor.center[1], cam.z - monitor.center[2]);
  const before = away(await s.eval('({ ...__officeCamera })'));
  console.log('owner', JSON.stringify(await s.eval('__office.state().owner')), 'screen', JSON.stringify(monitor.center));
  await s.waitFor(`__officeMonitor.getState().near === ${JSON.stringify(id)}`, 5000);
  assert(await s.eval(`!!document.querySelector('[data-monitor-prompt]')`), 'standing at the desk the owner is offered F to open its terminal');
  await s.shot('terminal-near');
  await s.press('KeyF', 'f');
  await s.waitFor(`__officeMonitor.getState().open === ${JSON.stringify(id)}`, 3000);
  await s.waitFor(`!!document.querySelector('.term-frame.ready')`, 5000);
  await s.sleep(500);
  const cam = await s.eval('({ ...__officeCamera })');
  console.log(`the camera is ${away(cam).toFixed(2)} m from the screen (was ${before.toFixed(1)} m)`);
  assert(away(cam) < 1.3 && before > 5, `F flies the camera in front of the monitor (${before.toFixed(1)} m away, now ${away(cam).toFixed(2)} m)`);
  const toward = (monitor.normal[0] * (cam.x - monitor.center[0]) + monitor.normal[1] * (cam.y - monitor.center[1]) + monitor.normal[2] * (cam.z - monitor.center[2])) / away(cam);
  assert(toward > 0.95, `it looks straight at the screen (${toward.toFixed(3)})`);
  const panel = await s.eval(`(() => { const r = document.querySelector('.term-frame').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const projected = await s.eval(`(() => { const [x, y, z] = __officeMonitors()[${JSON.stringify(id)}].center; return __office.project(x, y, z); })()`);
  assert(Math.abs(panel.x + panel.w / 2 - projected.x) < 12 && Math.abs(panel.y + panel.h / 2 - projected.y) < 12, `the terminal lies on the screen: its middle is at ${Math.round(panel.x + panel.w / 2)},${Math.round(panel.y + panel.h / 2)}, the screen's at ${Math.round(projected.x)},${Math.round(projected.y)}`);
  const body = await s.eval(`document.querySelector('.term-scroll').innerText`);
  assert(/Claude Code/.test(body) && /Create a file named hello\.txt/.test(body) && /Write\(hello\.txt\)/.test(body), 'the terminal holds the whole session: header, prompt and the calls');
  assert(await s.eval(`document.activeElement?.tagName === 'TEXTAREA'`), 'the prompt has the cursor');
  const type = await s.eval(`(() => { const el = document.querySelector('.term-screen'); const r = document.querySelector('.term-frame').getBoundingClientRect(); return { px: parseFloat(getComputedStyle(el).fontSize), line: parseFloat(getComputedStyle(el).lineHeight), h: r.height }; })()`);
  assert(type.px >= 18 && type.line / type.px >= 1.4, `the panel uses the room it has: ${type.px}px type on ${type.line}px lines in a panel ${Math.round(type.h)}px high`);
  await s.shot('terminal-zoom');

  // A message typed in the terminal reaches the employee: the ledger holds the owner post and she answers in the terminal.
  const posts = () => ledger().filter((e) => e.t === 'post' && e.msg.from === 'owner' && e.msg.to === id).map((e) => e.msg);
  const asking = 'What word is written in hello.txt? Answer with that word only.';
  const postsBefore = posts().length;
  await s.type(asking);
  await s.press('Enter');
  await s.waitFor(`!!document.querySelector('.term-scroll')?.innerText.includes(${JSON.stringify(asking)})`, 3000);
  assert((await s.eval(`document.querySelector('.term-prompt textarea').value`)) === '', 'Enter sends the message and empties the prompt');
  await s.waitFor(`1`, 10);
  const t0 = Date.now();
  while (posts().length === postsBefore && Date.now() - t0 < 10000) await s.sleep(100);
  const post = posts().at(-1);
  assert(post && post.text === asking && ['request', 'say'].includes(post.kind), `the mail ledger holds the owner post (${post?.kind}: ${post?.text})`);
  const reply = await s.waitFor(`document.querySelector('.term-scroll')?.innerText.split('${asking.slice(0, 20)}')[1]?.includes('hi')`, 60000);
  assert(reply, 'she answers in the terminal');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);
  await s.shot('terminal-answer');

  // Typed in the terminal while she works, a task shows its calls as they happen: the shot of the zoomed terminal mid-task.
  const status = () => s.eval(`${state}.company.employees[0].status.kind`);
  await s.type('Create three files a.txt, b.txt and c.txt, each containing its own letter, using your Write tool once per file. Then use your Bash tool to run ls. Then say done.');
  await s.press('Enter');
  await s.waitFor(`(document.querySelector('.term-scroll')?.innerText.match(/Write\\(/g) ?? []).length >= 3`, 60000);
  assert((await status()) === 'working', 'three calls are on the zoomed terminal while she is still at work');
  await s.shot('terminal-zoom-mid');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 90000);

  // The turns before this one are a row each, pinned above it. A click opens one, and another closes it.
  const rowsOf = (sel) => s.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((r) => r.innerText)`);
  const past = await rowsOf('.term-past .term-row');
  assert(past.length === 2 && past.every((r) => r.startsWith('▸')) && /hello\.txt/.test(past[0]) && /What word is written/.test(past[1]) && /→ hi/.test(past[1]), `two earlier turns are a row each: ${past.join(' | ')}`);
  assert(!(await s.eval(`document.querySelector('.term-scroll').innerText.includes('Write(hello.txt)')`)), 'and their calls are not in the log');
  await s.clickOn('.term-past .term-row', 'hello.txt');
  await s.waitFor(`!!document.querySelector('.term-past.loose')`, 3000);
  assert(await s.eval(`document.querySelector('.term-past.loose').innerText.includes('Write(hello.txt)')`), 'a click on a turn opens it, with its calls');
  assert((await s.eval(`parseFloat(getComputedStyle(document.querySelector('.term-past.loose .term-row:not(.term-act)')).opacity)`)) < 0.9, 'and what it shows is dimmer than the turn in progress');
  await s.clickOn('.term-past .term-row', 'hello.txt');
  await s.waitFor(`!document.querySelector('.term-past.loose')`, 3000);
  // A result that printed more than it shows says so, and a click opens it.
  assert(await s.eval(`document.querySelector('.term-scroll').innerText.includes('click to expand')`), 'a result with more to show says click to expand');
  await s.clickOn('.term-act', 'click to expand');
  await s.waitFor(`document.querySelector('.term-scroll').innerText.includes('click to collapse')`, 3000);
  await s.clickOn('.term-act', 'click to collapse');
  await s.waitFor(`!document.querySelector('.term-scroll').innerText.includes('click to collapse')`, 3000);

  // Esc during a step stops it. The shell is told to sleep, and Esc ends the turn: the office hears it, the terminal says so, nothing keeps running.
  // Claude Code refuses a bare sleep, so the slow command is a node process that waits for ever. Its name is made up here, so nothing else matches it.
  const marker = `m1-slow-${Math.random().toString(36).slice(2, 8)}`;
  const sleeping = () => {
    try {
      return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const turnsEnded = () => ledger().filter((e) => e.t === 'turn_end').length;
  const endedBefore = turnsEnded();
  await s.type(`Use your Bash tool to run exactly this command, and wait for it to finish: node -e "setInterval(() => {}, 1000)" ${marker}`);
  await s.press('Enter');
  await s.waitFor(`document.querySelector('.term-scroll')?.innerText.includes(${JSON.stringify(marker)})`, 60000);
  const started0 = Date.now();
  while (!sleeping().length && Date.now() - started0 < 15000) await s.sleep(200);
  assert((await status()) === 'working' && sleeping().length > 0, 'the shell command is running');
  await s.press('Escape', 'Escape');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 15000);
  assert(await s.eval(`document.querySelector('.term-scroll')?.innerText.includes('Interrupted')`), 'the terminal shows the interruption');
  assert(await s.eval(`__officeMonitor.getState().open === ${JSON.stringify(id)}`), 'Esc on a working employee stops her and does not leave the monitor');
  const stop = ledger().filter((e) => e.t === 'post' && e.msg.kind === 'reply' && e.msg.from === id).at(-1)?.msg;
  assert(turnsEnded() === endedBefore + 1 && stop?.outcome === 'failed' && /interrupted/i.test(stop.text), `the turn ended and the request settled: ${stop?.outcome}, "${stop?.text}"`);
  const gone0 = Date.now();
  while (sleeping().length && Date.now() - gone0 < 8000) await s.sleep(200);
  const left = sleeping();
  assert(left.length === 0, `the command she was running is gone ${Date.now() - gone0} ms after she was idle${left.length ? `: ${execFileSync('ps', ['-o', 'pid,ppid,etime,command', '-p', left.join(',')], { encoding: 'utf8' }).slice(0, 600)}` : ''}`);
  await s.shot('terminal-interrupted');

  // A permission dialog is in the terminal, and answering it there decides the call.
  await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(id)}, mode: 'ask' })`);
  await s.waitFor(`${state}.company.employees[0].permissions.mode === 'ask'`, 5000);
  const dialogOf = () => s.eval(`document.querySelector('.term-dialog')?.innerText ?? ''`);
  const ask = async (command, description) => {
    await s.type(`Use your Bash tool to run exactly this command: ${command}${description ? `. Give the call the description "${description}".` : ''}`);
    await s.press('Enter');
    await s.waitFor(`${state}.company.employees[0].status.kind === 'blocked_on_owner'`, 60000);
    await s.waitFor(`!!document.querySelector('.term-dialog')`, 3000);
    return dialogOf();
  };
  const rule = () => s.eval(`${state}.company.employees[0].permissions.alwaysAllow`);

  // A: yes, this once. The dialog is Claude Code's.
  let dialog = await ask('touch permission-ok.txt', 'Create the marker file');
  assert(/Bash command/.test(dialog) && /touch permission-ok\.txt/.test(dialog) && /Do you want to proceed\?/.test(dialog), `the dialog is in the terminal: ${dialog.replace(/\n+/g, ' | ').slice(0, 260)}`);
  assert(/Create the marker file/.test(dialog), 'it says what the model wrote the command is for');
  assert(/This command requires approval/.test(dialog), 'it says the command requires approval');
  assert(/1\. Yes/.test(dialog) && /2\. Yes, and don't ask again for: touch \*/.test(dialog) && /3\. No\s*(\n|$)/.test(dialog), 'the choices say the exact scope, and No is plain');
  assert(/Esc to cancel · Tab to amend/.test(dialog) && !/what to do differently/.test(dialog), 'the footer says Esc to cancel and Tab to amend, and no line repeats the No choice');
  assert(await s.eval(`document.querySelector('.term-box').getBoundingClientRect().width <= 1`), 'there is no second input line while a choice is pending');
  assert(await s.eval(`document.activeElement?.tagName === 'TEXTAREA'`), 'and the keys still reach the dialog');
  const dashed = await s.eval(`[...document.querySelectorAll('.term-dialog .term-row')].map((r) => r.innerText)`);
  assert(dashed.filter((r) => /^╌+$/.test(r.trim())).length === 2 && dashed.findIndex((r) => /touch permission-ok/.test(r)) === dashed.findIndex((r) => /^╌+$/.test(r.trim())) + 1, 'the command sits between two dashed rules');
  const onMonitor = await waitScreen(s, id, /Do you want to proceed\?/, 3000, 'the dialog on the monitor');
  assert(/touch permission-ok\.txt/.test(text(onMonitor.rows)) && /2\. Yes, and don't ask again for: touch \*/.test(text(onMonitor.rows)) && !/❯ █/.test(text(onMonitor.rows)), 'and on the monitor, with the same scope and no prompt box');
  await s.shot('terminal-permission');
  await s.press('1', '1');
  await s.waitFor(`!document.querySelector('.term-dialog')`, 5000);
  const touched = Date.now();
  while (!existsSync(join(repo, 'permission-ok.txt')) && Date.now() - touched < 30000) await s.sleep(200);
  assert(existsSync(join(repo, 'permission-ok.txt')) || existsSync(join(await s.eval(`${state}.company.employees[0].workspace?.path ?? ''`), 'permission-ok.txt')), 'answering 1 releases the tool: the command ran and the dialog went away');
  assert((await rule()).length === 0, 'and stored no rule');
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);

  // B: yes, and do not ask again. The rule stored is the one the choice named.
  dialog = await ask('git status --short');
  const scope = /don't ask again for: (.+)$/m.exec(dialog)?.[1];
  assert(scope === 'git status *', `the choice names its scope: ${scope}`);
  await s.press('2', '2');
  await s.waitFor(`!document.querySelector('.term-dialog')`, 5000);
  const stored = await rule();
  assert(stored.length === 1 && stored[0].kind === 'command' && `${stored[0].prefix} *` === scope, `the rule stored is the scope shown: ${JSON.stringify(stored)}`);
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);

  // C: no, with words. Tab opens them under No.
  dialog = await ask('touch denied.txt');
  assert(!/what to do differently/.test(dialog), 'the dialog opens with no words typed under No');
  await s.chord('Tab');
  await s.waitFor(`document.querySelector('.term-dialog')?.innerText.includes('3. No, and tell them what to do differently:')`, 3000);
  await s.type('use ls instead');
  await s.waitFor(`document.querySelector('.term-dialog')?.innerText.includes('what to do differently: use ls instead')`, 3000);
  assert(/Enter to send · Esc to cancel/.test(await dialogOf()), 'Tab turns the footer into Enter to send');
  await s.press('Enter');
  await s.waitFor(`!document.querySelector('.term-dialog')`, 5000);
  await s.waitFor(`${state}.company.employees[0].status.kind === 'idle'`, 60000);
  assert(!existsSync(join(repo, 'denied.txt')), 'No keeps the command from running');
  assert(await s.eval(`document.querySelector('.term-scroll')?.innerText.includes('They said: No, use ls instead')`), 'and the words go back to the employee');

  // Esc on someone with nothing to stop leaves, and the camera comes back.
  await s.press('Escape', 'Escape');
  await s.waitFor(`__officeMonitor.getState().open === null`, 3000);
  await s.sleep(1200);
  const back = away(await s.eval('({ ...__officeCamera })'));
  assert(back > 5 && !(await s.eval(`!!document.querySelector('.term-frame')`)), `Esc leaves and the camera returns (${back.toFixed(1)} m from the screen)`);

  // A click on the screen opens it too, from anywhere the screen can be seen. The overview turns until the screen faces it.
  await s.eval(`__office.teleport(${at.x + 6}, ${at.z + 1.4}, 0)`);
  await s.sleep(1000);
  const facing = async () => {
    const cam = await s.eval('({ ...__officeCamera })');
    return (cam.x - monitor.center[0]) * monitor.normal[0] + (cam.z - monitor.center[2]) * monitor.normal[2] > 0;
  };
  for (let turns = 0; turns < 3 && !(await facing()); turns++) {
    await s.press('KeyQ', 'q');
    await s.sleep(1300);
  }
  assert(await facing(), 'the screen faces the overview camera');
  const spot = await s.eval(`(() => { const [x, y, z] = __officeMonitors()[${JSON.stringify(id)}].center; return __office.project(x, y, z); })()`);
  const hit = await s.eval(`__office.pick(${spot.x}, ${spot.y})`);
  await s.click(spot.x, spot.y);
  await s.waitFor(`__officeMonitor.getState().open === ${JSON.stringify(id)}`, 3000).catch(() => {
    throw new Error(`a click at ${Math.round(spot.x)},${Math.round(spot.y)} did not open the terminal (it reaches ${JSON.stringify(hit)})`);
  });
  assert(true, `a click on the monitor opens the terminal (${hit.kind})`);
  await s.waitFor(`!!document.querySelector('.term-frame.ready')`, 5000);
  await s.press('Escape', 'Escape');
  await s.waitFor(`__officeMonitor.getState().open === null`, 3000);
}
