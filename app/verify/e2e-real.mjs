// Real Electron app, real Claude employee. Everything the owner does goes through the UI.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-real.mjs
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HAIKU, assert, claude, company, diagnoseClaude, scratch, status, stepUntil, text, typeToNearest, walkUpToClaude } from './lib.mjs';

const { dataDir, repo } = scratch();

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: HAIKU,
  OFFICE_TEST_PICK_FOLDER: repo,
  // Makes the main process log each MCP tool call and each Claude session's connected servers.
  OFFICE_DEBUG: '1',
};

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.sleep(1500);

  const voices = await s.eval('speechSynthesis.getVoices().length');
  console.log('speech: voices', voices, '| recognizer supported', await s.eval('__office.store.getState().voice.supported'));

  // First run: no blocks, a friendly prompt, and no way to hire yet.
  assert((await s.eval(`${company}.blocks.length`)) === 0, 'a fresh data dir starts with no blocks');
  assert((await s.eval(text('.first-run'))).includes('Add your first project block'), 'HUD shows the first-run prompt');
  assert(await s.eval(`[...document.querySelectorAll('.co-row .btn')].find(b => b.innerText === 'Hire').disabled`), 'Hire is disabled without a block');
  await s.shot('u0-1-first-run');

  // New block through the stubbed picker.
  assert(await s.clickText('.first-run .btn', 'Choose a folder'), 'first-run button opens New block');
  await s.waitFor(`!!document.querySelector('.modal')`);
  assert(await s.eval(`document.querySelector('.modal .btn.primary').disabled`), 'Create is disabled until a folder is chosen');
  assert(await s.clickText('.modal button', 'Choose folder'), 'clicked Choose folder…');
  await s.waitFor(`document.querySelector('.folder-path').title === ${JSON.stringify(repo)}`);
  const prefilled = await s.eval(`document.querySelector('.modal input').value`);
  assert(prefilled === basename(repo), `name is prefilled from the folder basename (${prefilled})`);
  await s.shot('u0-2-new-block');
  assert(await s.clickText('.modal .btn.primary', 'Create block'), 'clicked Create block');
  await s.waitFor(`${company}.blocks.length === 1`);
  const block = await s.eval(`${company}.blocks[0]`);
  assert(block.cwd === repo && block.name === basename(repo), `block points at the repo and is named ${block.name}`);
  assert(!(await s.eval(`!!document.querySelector('.first-run')`)), 'first-run prompt is gone');
  const row = await s.eval(text('.blocks li'));
  assert(row.includes(basename(repo)) && row.includes('Reveal'), `HUD lists the block with a Reveal action (${row})`);

  // A second block on the same folder is refused, in the UI and in main.
  await s.clickText('.blocks-head .btn', 'New block');
  await s.clickText('.modal button', 'Choose folder');
  await s.waitFor(`!!document.querySelector('.modal .err-text')`);
  assert(await s.eval(`document.querySelector('.modal .btn.primary').disabled`), 'modal refuses a duplicate folder');
  assert(await s.clickText('.modal .btn', 'Cancel'), 'closed the modal');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.innerText.includes('already works in'))`);
  assert((await s.eval(`${company}.blocks.length`)) === 1, 'main rejected the duplicate cwd');

  // Hire modal: all three harnesses, honest states.
  await s.clickText('.co-row .btn', 'Hire');
  await s.waitFor(`document.querySelectorAll('.prov-card').length === 3`);
  const cards = await s.eval(`[...document.querySelectorAll('.prov-card')].map(c => ({ text: c.innerText.replace(/\\n+/g, ' | '), disabled: c.disabled }))`);
  console.log('hire cards', JSON.stringify(cards));
  assert(cards[0].text.includes('Claude Code') && /Ready · v\d/.test(cards[0].text) && !cards[0].disabled, 'Claude Code is ready and enabled');
  assert(cards[1].disabled && cards[2].disabled, 'Codex and Hermes are disabled');
  assert(cards.slice(1).every((c) => /Installed, but the office cannot drive it yet|Not installed/.test(c.text)), 'Codex and Hermes say why');
  await s.shot('u0-3-hire-modal');
  await s.eval(`(() => {
    const sel = document.querySelector('.modal select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, sel.options[0].value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert(await s.clickText('.modal .btn.primary', 'Hire'), 'clicked Hire');
  await s.waitFor(`!!${claude}`);

  // Main refuses a provider that is not ready even if the renderer asks.
  await s.eval(`window.office.send({ type: 'hire', provider: 'codex', blockId: ${company}.blocks[0].id })`);
  await s.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.innerText.includes('not connected to the office'))`);
  assert((await s.eval(`${company}.employees.length`)) === 1, 'main refused to hire a provider that is not wired');

  const hired = await s.eval(claude);
  assert(hired.model === HAIKU && hired.permissions.mode === 'inherit' && hired.permissions.alwaysAllow.length === 0 && hired.subagents.length === 0, `the hire took OFFICE_CLAUDE_MODEL and the company default mode (${hired.model})`);

  const name = await s.eval(`${claude}.name`);
  await s.eval('__office.step(25)');
  assert(await walkUpToClaude(s), `walked up to ${name}`);
  await s.shot('u0-4-office');

  // Task 1: ask_owner with two options, then write a file.
  await typeToNearest(
    s,
    'Create a file named hello.txt whose whole content is the single word hello. Before writing it, call the ask_owner tool to ask me whether to end the file with a newline, with exactly two options: Newline and No newline.',
  );
  await s.waitFor(`${status}.kind === 'working'`, 15000);
  await s.eval(`__office.teleport(-16.5, 5.9, Math.PI); __office.setCamera('follow'); __office.step(0.5)`);
  const t0 = Date.now();
  await s.waitFor(`${status}.kind === 'blocked_on_owner'`, 120000);
  const question = await s.eval(`${status}.question`);
  console.log(`blocked after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(question));
  assert(question.kind === 'ask' && question.options?.length === 2, 'ask_owner arrived as kind ask with two options');
  await stepUntil(s, `__office.state().askerId === ${claude}.id && !!document.querySelector('.qcard')`, 60000, 'the employee to reach the owner and show the card');
  await s.sleep(800);
  console.log('card:', await s.eval(text('.qcard')));
  assert(!(await s.eval(`!!document.querySelector('.qcard.permission')`)), 'an ask card does not use the permission look');
  await s.shot('u0-5-ask-card');
  const chosen = await s.eval(`(() => { const b = document.querySelectorAll('.qcard .opts button')[1]; b.click(); return b.innerText; })()`);
  console.log('clicked option:', chosen);
  await s.waitFor(`${status}.kind === 'idle'`, 120000);
  const hello = join(repo, 'hello.txt');
  assert(existsSync(hello), 'hello.txt exists in the block folder');
  console.log('hello.txt =', JSON.stringify(readFileSync(hello, 'utf8')), '| activity:', await s.eval(`${claude}.activity`));
  assert(readFileSync(hello, 'utf8').startsWith('hello'), 'hello.txt starts with hello');
  // The question travelled over the office's own MCP server, not an in-process tool.
  const mainOut = s.mainLogs.join('\n');
  console.log('mcp log lines:\n  ' + mainOut.split('\n').filter((l) => /\[mcp\]|mcp=/.test(l)).join('\n  '));
  assert(/\[mcp\] listening on 127\.0\.0\.1:\d+/.test(mainOut), 'the office MCP server is listening on 127.0.0.1');
  assert(/\[mcp\] \S+ ask_owner over http/.test(mainOut), 'main log shows ask_owner arriving over http');
  assert(/mcp=office:connected/.test(mainOut), 'Claude reports the office MCP server as connected');

  // Task 2: a shell command has to ask permission, and the card shows it verbatim.
  await stepUntil(s, '__office.state().avatars[0].seated', 60000, 'the employee to sit back down');
  assert(await walkUpToClaude(s), `walked up to ${name} again`);
  // acceptEdits auto-approves mkdir, touch and redirects inside the folder, so the command has to be one it does not know.
  await typeToNearest(s, `Use the Bash tool, not Write, to run exactly this command: node -e "require('fs').writeFileSync('done.txt', 'done')"`);
  await s.eval(`__office.teleport(-16.5, 5.9, Math.PI); __office.step(0.5)`);
  await s.waitFor(`${status}.kind === 'blocked_on_owner' && ${status}.question.kind === 'permission'`, 120000);
  const perm = await s.eval(`${status}.question`);
  console.log('permission question:', JSON.stringify(perm));
  assert(perm.tool === 'Bash' && perm.detail.includes('writeFileSync'), 'permission carries the tool and the command');
  await stepUntil(s, `__office.state().askerId === ${claude}.id && !!document.querySelector('.qcard.permission')`, 60000, 'the permission card');
  await s.sleep(800);
  assert((await s.eval(text('.qcard.permission .cmd'))).includes('writeFileSync'), 'card shows the command in the monospace block');
  assert(await s.eval(`getComputedStyle(document.querySelector('.qcard .cmd')).fontFamily.includes('monospace')`), 'the command block is monospace');
  assert((await s.eval(`[...document.querySelectorAll('.qcard .opts button')].map(b => b.innerText).join()`)) === 'Allow,Deny', 'card offers Allow and Deny');
  await s.shot('u0-6-permission-card');
  assert(await s.clickText('.qcard .opts button', 'Allow'), 'clicked Allow');
  await s.waitFor(`${status}.kind === 'idle'`, 120000);
  assert(existsSync(join(repo, 'done.txt')), 'the allowed command ran (done.txt exists)');

  // Claude runs a subagent in the background unless told not to, and the call that launched it then returns at once.
  // So the check times the doll. One that ended with that call would last a few milliseconds, and a subagent needs at
  // least a model call and two reads.
  await stepUntil(s, '__office.state().avatars[0].seated', 60000, 'the employee to sit back down');
  assert(await walkUpToClaude(s), `walked up to ${name} a third time`);
  await s.eval(`(() => {
    window.__dolls = [];
    __office.store.subscribe((state) => {
      const e = state.company?.employees.find((x) => x.provider === 'claude-code');
      const n = e?.subagents.length ?? 0;
      if (n !== (window.__dolls.at(-1)?.n ?? 0)) window.__dolls.push({ n, at: Date.now(), status: e.status.kind, labels: e.subagents.map((x) => x.label), parents: e.subagents.map((x) => x.parentId) });
    });
  })()`);
  await typeToNearest(
    s,
    'Use the Agent tool exactly once. Give the subagent this prompt: "Read hello.txt and done.txt in the current folder one at a time, then reply with the word DONE." Then tell me what it replied.',
  );
  let heldSubagent = false;
  const watchFrom = Date.now();
  while (!(await s.eval('window.__dolls.some((d) => d.n > 0) && window.__dolls.at(-1).n === 0'))) {
    if (Date.now() - watchFrom > 180000) throw new Error('timeout waiting for a subagent to show up and end');
    heldSubagent ||= readFileSync(join(dataDir, 'company.json'), 'utf8').includes('"subagents"');
    if ((await s.eval(`${status}.kind`)) === 'blocked_on_owner') {
      console.log('the subagent asked permission:', JSON.stringify(await s.eval(`${status}.question`)));
      await s.eval(`window.office.send({ type: 'answer', employeeId: ${claude}.id, questionId: ${status}.question.id, text: 'Allow' })`);
    }
    await s.sleep(100);
  }
  const dolls = await s.eval('window.__dolls');
  console.log('subagents seen on the desk:', JSON.stringify(dolls));
  assert(dolls[0].n >= 1 && dolls[0].labels[0]?.length > 0 && dolls[0].parents[0] === null, `a subagent showed on the employee while it ran, labelled "${dolls[0].labels[0]}"`);
  const lifetime = dolls.at(-1).at - dolls[0].at;
  assert(lifetime >= 1500, `the doll stayed for the whole run of the subagent, ${(lifetime / 1000).toFixed(1)}s, not just for the call that launched it`);
  assert(dolls.at(-1).n === 0 && (await s.eval(`${claude}.subagents.length`)) === 0, 'and it was gone once it ended');
  console.log(`the employee was ${dolls[0].status} when the doll appeared and ${dolls.at(-1).status} when it left`);
  assert(!heldSubagent, 'company.json never held the subagent while it ran');
  await s.waitFor(`${status}.kind === 'idle'`, 120000);

  // The company file lives under the data dir, and holds the block and the employee.
  const saved = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
  assert(saved.blocks.length === 1 && saved.employees.length === 1, `company.json in OFFICE_DATA_DIR has 1 block and 1 employee (xp ${saved.xp})`);
  const [savedEmployee] = saved.employees;
  assert(savedEmployee.model === HAIKU && savedEmployee.permissions.mode === 'inherit' && !('subagents' in savedEmployee) && saved.settings.defaultPermissions === 'inherit', 'company.json holds the model, the policy and the settings, and no subagents');

  // Whiteboard: mermaid must still render under the built page's CSP.
  await s.eval(`(() => {
    const st = __office.store.getState();
    const c = structuredClone(st.company);
    c.blocks[0].whiteboard = { title: 'Flow', mermaid: 'flowchart LR\\n A[Owner] --> B[Employee]', by: c.employees[0].id, at: Date.now() };
    __office.apply({ type: 'snapshot', company: c, harnesses: st.harnesses, catalogs: st.catalogs, meetingDoor: st.meetingDoor });
    __office.set({ modal: { kind: 'whiteboard', blockId: c.blocks[0].id } });
  })()`);
  await s.waitFor(`!!document.querySelector('.wb-body .svg svg')`, 20000);
  assert(await s.eval(`!!document.querySelector('.wb-body .svg svg')`), 'whiteboard diagram rendered as SVG under the CSP');
  await s.shot('u0-7-whiteboard');
};

// Called by the driver when a step fails, so a timeout comes with the state that explains it.
export const diagnose = (s) => diagnoseClaude(s, 'u0-failure');
