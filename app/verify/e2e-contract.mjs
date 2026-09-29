// Real Electron app, real Claude employees. The app starts on a company.json from before models, permissions and
// settings. The Contract v2 messages then go through the real IPC and zod boundary, and each result is read back from
// the snapshot, from company.json and from what the real Claude session did.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-contract.mjs
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, company, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const OLD_SESSION = '7f2c5e0a-1111-4222-8333-944455556666';
const ALIAS = 'claude-haiku-4-5';
const BOGUS = 'claude-not-a-real-model-9';
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-v1.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_DEBUG: '1' };

const emp = (name) => `${company}.employees.find((e) => e.name === ${JSON.stringify(name)})`;
const stored = () => JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
const storedEmployee = (name) => stored().employees.find((e) => e.name === name);

export default async (s) => {
  const send = (msg) => s.eval(`window.office.send(${JSON.stringify(msg)})`);
  const logs = (name) => s.eval(`(__office.store.getState().logs[${emp(name)}.id] ?? []).map((l) => l.line)`);
  const idle = (name, ms = 120000) => s.waitFor(`${emp(name)}.status.kind === 'idle'`, ms);
  const runTask = async (name, task) => {
    await send({ type: 'assign', employeeId: await s.eval(`${emp(name)}.id`), task });
    await s.waitFor(`${emp(name)}.status.kind === 'working'`, 15000);
    await idle(name);
  };
  const untilMainLog = async (pattern, ms = 10000) => {
    const from = Date.now();
    while (Date.now() - from < ms) {
      if (pattern.test(s.mainLogs.join('\n'))) return true;
      await s.sleep(100);
    }
    return false;
  };
  const answerCard = async (name, fields) => {
    await s.waitFor(`${emp(name)}.status.kind === 'blocked_on_owner' && ${emp(name)}.status.question.kind === 'permission'`, 120000);
    const question = await s.eval(`${emp(name)}.status.question`);
    await send({ type: 'answer', employeeId: await s.eval(`${emp(name)}.id`), questionId: question.id, text: 'Allow', ...fields });
    return question;
  };

  await s.waitFor(`!!${company}`);
  await s.sleep(1000);

  const migrated = await s.eval(company);
  assert(migrated.employees.length === 2 && migrated.employees.every((e) => e.model === HAIKU && e.permissions.mode === 'inherit' && e.permissions.alwaysAllow.length === 0 && e.subagents.length === 0), `the app started on the old company.json and every employee got the model from OFFICE_CLAUDE_MODEL and the inherit mode`);
  assert(JSON.stringify(migrated.settings) === JSON.stringify({ seats: { total: 4, perBlock: 3 }, defaultModels: {}, defaultPermissions: 'inherit' }), 'the company got its settings, seats at the ceiling of level 3');
  assert(migrated.employees[0].sessionId === OLD_SESSION && migrated.blocks[0].whiteboard.title === 'Billing flow', 'and kept what the old file held');
  assert(JSON.stringify(await s.eval('__office.store.getState().catalogs')) === JSON.stringify({ 'claude-code': { kind: 'unknown' }, codex: { kind: 'unknown' }, hermes: { kind: 'unknown' } }), 'the snapshot carries a catalog for every harness, none asked for yet');
  assert(storedEmployee('Ben').model === HAIKU && !readFileSync(join(dataDir, 'company.json'), 'utf8').includes('subagents'), 'the migrated file was written back, without subagents');

  const blockId = migrated.blocks[0].id;
  await send({ type: 'set_permissions', employeeId: migrated.employees[1].id, mode: 'ask' });
  await s.waitFor(`${emp('Ben')}.permissions.mode === 'ask'`, 5000);
  assert(storedEmployee('Ben').permissions.mode === 'ask' && storedEmployee('Ana').permissions.mode === 'inherit', 'set_permissions changes one employee, in the snapshot and in the file');
  await send({ type: 'set_permissions', employeeId: migrated.employees[1].id, mode: 'inherit' });
  await send({ type: 'set_permissions', employeeId: migrated.employees[1].id, mode: 'bogus' });
  await s.waitFor(`__office.store.getState().toasts.some((t) => t.text.includes('Bad message'))`, 5000);
  await s.waitFor(`${emp('Ben')}.permissions.mode === 'inherit'`, 5000);
  await s.sleep(300);
  assert((await s.eval(`${emp('Ben')}.permissions.mode`)) === 'inherit', 'a mode the schema does not know is refused at the boundary and changes nothing');
  await send({ type: 'load_models', provider: 'claude-code' });
  await send({ type: 'hire', provider: 'claude-code', blockId, name: 'Cy', model: ALIAS });
  await s.waitFor(`!!${emp('Cy')}`, 5000);
  assert((await s.eval(`${emp('Cy')}.model`)) === ALIAS && (await s.eval('__office.store.getState().catalogs["claude-code"].kind')) === 'unknown', 'hire takes a model, and asking a harness that cannot list models leaves its catalog unknown');

  const benId = await s.eval(`${emp('Ben')}.id`);
  const command = (file) => `node -e "require('fs').writeFileSync('${file}', 'x')"`;
  const node = (file) => `Use the Bash tool, not Write, to run exactly this command: ${command(file)}`;
  const flat = (text) => text.replace(/\s+/g, ' ');
  await send({ type: 'assign', employeeId: benId, task: node('one.txt') });
  const card = await answerCard('Ben', { always: true });
  assert(card.tool === 'Bash' && card.detail.includes('writeFileSync'), 'the first run of the command puts a permission card on the desk');
  await idle('Ben');
  const rules = await s.eval(`${emp('Ben')}.permissions.alwaysAllow`);
  assert(existsSync(join(repo, 'one.txt')) && rules.length === 1 && rules[0].kind === 'exact' && flat(rules[0].command) === flat(card.detail), 'Allow with always ran it and added an exact rule for that command, because node can run any code');
  assert(JSON.stringify(storedEmployee('Ben').permissions.alwaysAllow) === JSON.stringify(rules), 'the rule is in company.json');
  await s.eval(`(() => { window.__cards = 0; __office.store.subscribe((st) => { if (st.company.employees.find((e) => e.name === 'Ben').status.kind === 'blocked_on_owner') window.__cards++; }); })()`);
  rmSync(join(repo, 'one.txt'));
  await runTask('Ben', node('one.txt'));
  assert(existsSync(join(repo, 'one.txt')) && (await s.eval('window.__cards')) === 0, 'the identical command ran again with no card');
  assert((await logs('Ben')).some((l) => l.startsWith('Allowed by your rule "node -e') && l.includes('one.txt')), 'and the log says the rule allowed it');
  await send({ type: 'assign', employeeId: benId, task: node('two.txt') });
  const other = await answerCard('Ben', {});
  assert(other.kind === 'permission' && other.detail.includes('two.txt'), 'another node command still asks, because the rule covers only the command it was made from');
  await idle('Ben');
  assert(existsSync(join(repo, 'two.txt')), 'and runs once the owner allows it');
  await send({ type: 'remove_allow_rule', employeeId: benId, rule: rules[0] });
  await s.waitFor(`${emp('Ben')}.permissions.alwaysAllow.length === 0`, 5000);
  rmSync(join(repo, 'one.txt'));
  await send({ type: 'assign', employeeId: benId, task: node('one.txt') });
  await answerCard('Ben', {});
  await idle('Ben');
  assert(existsSync(join(repo, 'one.txt')), 'after remove_allow_rule the identical command asks again');

  await send({ type: 'set_model', employeeId: benId, model: ALIAS });
  assert(await untilMainLog(new RegExp(`model switched to ${ALIAS}`)), 'the live session accepted the new model');
  assert((await s.eval(`${emp('Ben')}.model`)) === ALIAS && storedEmployee('Ben').model === ALIAS, 'set_model changes the employee and the file');
  await runTask('Ben', 'Reply with just the word ok.');
  assert(new RegExp(`init model=${ALIAS} tools`).test(s.mainLogs.join('\n')), 'and the next turn started on it');
  await send({ type: 'set_model', employeeId: benId, model: BOGUS });
  await s.waitFor(`(__office.store.getState().logs[${emp('Ben')}.id] ?? []).some((l) => l.line.startsWith('Could not switch to ${BOGUS}'))`, 10000);
  assert((await logs('Ben')).some((l) => l.includes(`Model '${BOGUS}' not found`)), 'a model the SDK refuses is told to the owner in the log');
  await send({ type: 'set_model', employeeId: benId, model: HAIKU });
  await runTask('Ben', 'Reply with just the word ok.');
  assert((await s.eval(`${emp('Ben')}.status.kind`)) === 'idle', 'and the session keeps working after a refused switch');

  // Ana's file names a conversation that does not exist, so a new turn can only work if fresh_session cleared it.
  const anaId = await s.eval(`${emp('Ana')}.id`);
  await send({ type: 'fresh_session', employeeId: anaId });
  await s.waitFor(`${emp('Ana')}.sessionId === undefined`, 5000);
  assert(!('sessionId' in storedEmployee('Ana')) && (await logs('Ana')).includes('Started a fresh session'), 'fresh_session clears the sessionId, in the snapshot and in the file');
  await runTask('Ana', 'Reply with just the word ok.');
  const fresh = await s.eval(`${emp('Ana')}.sessionId`);
  assert(typeof fresh === 'string' && fresh !== OLD_SESSION, `the new session started a conversation of its own (${fresh})`);

  await s.eval(`(() => {
    window.__cy = [];
    __office.store.subscribe((st) => {
      const e = st.company.employees.find((x) => x.name === 'Cy');
      const last = window.__cy.at(-1);
      if (!last || last.n !== e.subagents.length || last.status !== e.status.kind) window.__cy.push({ n: e.subagents.length, status: e.status.kind, at: Date.now() });
    });
  })()`);
  const cyId = await s.eval(`${emp('Cy')}.id`);
  await send({
    type: 'assign',
    employeeId: cyId,
    task: 'Use the Agent tool exactly once, with run_in_background set to true. Give the subagent this prompt: "Read one.txt, two.txt and three.txt in the current folder one at a time, then reply with the word DONE." After you launch it, say only that you launched it.',
  });
  const from = Date.now();
  while (!(await s.eval('window.__cy.some((x) => x.n > 0) && window.__cy.at(-1).n === 0'))) {
    if (Date.now() - from > 180000) throw new Error('timeout waiting for the background subagent to show up and end');
    if ((await s.eval(`${emp('Cy')}.status.kind`)) === 'blocked_on_owner') await answerCard('Cy', {});
    await s.sleep(100);
  }
  const cy = await s.eval('window.__cy');
  console.log('Cy over time:', JSON.stringify(cy));
  assert(cy.some((x) => x.n > 0 && x.status === 'idle'), 'the employee was idle while the subagent was still running: it ended with its own report, not with the call that launched it');
  await idle('Cy');
  await s.sleep(4000);
  await idle('Cy');
  assert((await s.eval(`${emp('Cy')}.subagents.length`)) === 0 && !readFileSync(join(dataDir, 'company.json'), 'utf8').includes('subagents'), 'and afterwards it was gone from the desk and never written to the file');
};

export const diagnose = async (s) => {
  const state = await s.eval(`JSON.stringify(${company}.employees.map((e) => ({ name: e.name, model: e.model, status: e.status.kind, activity: e.activity, permissions: e.permissions, subagents: e.subagents.length, logs: (__office.store.getState().logs[e.id] ?? []).slice(-5).map((l) => l.line) })), null, 1)`);
  console.log('employees at failure:', state);
  await s.shot('c1-contract-failure');
};
