// Real bridge, real Claude employee: hire from the HUD, walk up and give work by typing, get walked-to, answer on the card.
// Run: OFFICE_START_LEVEL=3 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 pnpm dev, then node world/verify/cdp.mjs world/verify/e2e-real.mjs
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const url = 'http://localhost:5173/';

const company = `__office.store.getState().company`;
const emp = (provider) => `${company}.employees.find(e => e.provider === '${provider}')`;
const clickText = (sel, text) =>
  `(() => { const b = [...document.querySelectorAll('${sel}')].find(b => b.innerText.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`;

async function hire(s, provider, label, blockName) {
  if (!(await s.eval(clickText('button.btn.primary', 'Hire')))) throw new Error('no hire button');
  await s.sleep(200);
  await s.eval(clickText('.prov-card', label));
  await s.eval(`(() => {
    const sel = document.querySelector('.modal select');
    const opt = [...sel.options].find(o => o.text.startsWith(${JSON.stringify(blockName)}));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.sleep(100);
  await s.eval(clickText('.modal .btn.primary', 'Hire'));
  await s.waitFor(`!!${emp(provider)}`);
}

async function walkUpTo(s, provider) {
  const id = await s.eval(`${emp(provider)}.id`);
  const a = await s.eval(`__office.state().avatars.find(a => a.id === '${id}')`);
  await s.eval(`__office.teleport(${a.x}, ${a.z + 1.1}, 0); __office.step(0.5)`);
  await s.sleep(400);
  return s.eval(`__office.state().talkingTo`);
}

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.eval('window.__spoken = []; speechSynthesis.speak = (u) => { __spoken.push(u.text); };');
  await s.sleep(1500);
  await s.shot('r0-empty-office');

  await hire(s, 'claude-code', 'Claude Code', 'Client Apps');
  await hire(s, 'codex', 'Codex', 'Podium');
  await hire(s, 'cursor', 'Cursor', 'Syntax');
  await s.eval('__office.step(25)');
  console.log('hired', await s.eval(`${company}.employees.map(e => e.name + ' ' + e.provider)`));

  console.log('talkingTo codex', await walkUpTo(s, 'codex'));
  await s.press('Enter');
  await s.type('Draft the podium landing page plan');
  await s.press('Enter');
  await s.sleep(500);
  console.log('codex status', await s.eval(`${emp('codex')}.status.kind`));

  const claudeName = await s.eval(`${emp('claude-code')}.name`);
  console.log('talkingTo claude', await walkUpTo(s, 'claude-code'), claudeName);
  await s.shot('r1-talking-to-claude');
  await s.press('Enter');
  await s.type(
    'Create notes.md with a two line summary of what an online office for AI agents is. Before writing it, use ask_owner to ask me whether it should be in English or Portuguese, options English and Portuguese.',
  );
  await s.press('Enter');
  await s.waitFor(`${emp('claude-code')}.status.kind === 'working'`, 10000);
  console.log('claude status', await s.eval(`${emp('claude-code')}.status.kind`));

  await s.eval(`__office.teleport(-16.5, 5.9, Math.PI); __office.setCamera('follow'); __office.step(0.5)`);
  const t0 = Date.now();
  await s.waitFor(`${emp('claude-code')}.status.kind === 'blocked_on_owner'`, 120000);
  console.log(`claude blocked after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, await s.eval(`${emp('claude-code')}.status.question.text`));
  await s.eval('__office.step(20)');
  await s.sleep(1200);
  console.log('asker', await s.eval('__office.state().askerId'), 'spoken', await s.eval('JSON.stringify(__spoken)'));
  console.log('card', await s.eval("document.querySelector('.qcard')?.innerText.replace(/\\n/g, ' | ')"));
  await s.shot('r2-claude-at-owner-follow');
  await s.eval(`__office.setCamera('iso')`);
  await s.sleep(1200);
  await s.shot('r3-claude-at-owner-iso');
  await s.eval(`__office.setCamera('first')`);
  await s.sleep(1200);
  await s.shot('r4-claude-at-owner-first');
  await s.eval(`__office.setCamera('follow')`);

  const answered = await s.eval(
    `(() => { const card = [...document.querySelectorAll('.qcard')].find(c => c.innerText.includes(${JSON.stringify(claudeName)})); const b = card && [...card.querySelectorAll('.opts button')].find(b => /english/i.test(b.innerText)); b?.click(); return !!b; })()`,
  );
  console.log('clicked English on the card', answered);
  await s.waitFor(`${emp('claude-code')}.status.kind === 'idle'`, 120000);
  console.log('claude done:', await s.eval(`${emp('claude-code')}.activity`));
  const notes = `${homedir()}/online-office/workspaces/client-apps/notes.md`;
  console.log('notes.md exists', existsSync(notes), existsSync(notes) ? JSON.stringify(readFileSync(notes, 'utf8')) : '');
  console.log('company xp', await s.eval(`${company}.xp`), 'level', await s.eval(`${company}.level`));

  await s.eval('__office.step(20)');
  await s.eval(`__office.setCamera('iso'); __office.teleport(-6, 0, Math.PI); __office.step(1)`);
  await s.sleep(1500);
  await s.shot('r5-overview-after');
  console.log('said log (last 6)', await s.eval(`JSON.stringify(__spoken.slice(-6))`));
};
