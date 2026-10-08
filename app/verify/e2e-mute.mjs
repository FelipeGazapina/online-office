// The owner mutes their own mic and the employees' voices from the bar under the chat, and works by chat only. Real clicks on
// the built app; Chromium's fake capture device stands in for the mic. One idle employee is put in the renderer's company so
// the owner has someone in earshot; nobody is hired and no model runs.
// Run: pnpm build && OFFICE_CDP_PORT=9351 node verify/cdp.mjs verify/e2e-mute.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const state = '__office.store.getState()';
const capture = (s) => s.eval(`${state}.voice.capture.kind`);
const spoken = (s) => s.eval('window.__spoken.slice()');

async function setup(s) {
  await s.waitFor(`!!${state}.company && !!${state}.building`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  // Count what the employees would say out loud.
  await s.eval(`(() => { window.__spoken = []; const real = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = (u) => { window.__spoken.push(u.text); real(u); }; })()`);
}

async function companion(s) {
  await s.eval(`(() => {
    const c = ${state}.company;
    const seat = ${state}.building.stories[0].items.find((i) => i.def === 'bench_desk')?.id ?? null;
    const e = { id: 'mia', name: 'Mia', provider: 'claude-code', role: 'employee', blockId: c.blocks[0].id, seat, status: { kind: 'idle' }, activity: '', model: 'claude-haiku-4-5-20251001', permissions: { mode: 'default', alwaysAllow: [] }, subagents: [], hiredAt: 1 };
    __office.store.setState({ company: { ...c, employees: [...c.employees, e] } });
  })()`);
  for (let i = 0; i < 90 && !(await s.eval(`__office.state().avatars.find((a) => a.id === 'mia')?.seated`)); i++) await s.eval('__office.step(1)');
  const a = await s.eval(`__office.state().avatars.find((a) => a.id === 'mia')`);
  for (const [dx, dz] of [[0, 1.1], [0, -1.1], [1.1, 0], [-1.1, 0], [0.8, 0.8], [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8]]) {
    await s.eval(`__office.teleport(${a.x + dx}, ${a.z + dz}, 0); __office.step(0.3)`);
    if ((await s.eval(`${state}.talkingTo`)) === 'mia') return a;
  }
  throw new Error(`could not stand in earshot of Mia at ${JSON.stringify(a)}`);
}

const say = (s, text) => s.eval(`__office.apply({ type: 'said', employeeId: 'mia', text: ${JSON.stringify(text)} })`);

export default async (s, { launch }) => {
  await setup(s);
  await companion(s);
  assert((await s.eval(`${state}.talkingTo`)) === 'mia', 'the owner stands in earshot of Mia');
  await s.waitFor(`${state}.voice.capture.kind === 'open'`, 15000);
  assert((await capture(s)) === 'open', 'next to someone, the mic is open');
  await say(s, 'first line, out loud');
  assert((await spoken(s)).includes('first line, out loud'), 'with voices on, what Mia says is spoken');

  const mic = await s.center('[data-testid=mute-mic]', 'Mic on');
  const voices = await s.center('[data-testid=mute-voices]', 'Voices on');
  assert(mic && voices, 'the bar under the chat shows "Mic on" and "Voices on"');
  await s.click(mic.x, mic.y);
  await s.waitFor(`${state}.micMuted && ${state}.voice.capture.kind === 'closed'`, 5000);
  assert((await capture(s)) === 'closed', 'a click on "Mic on" mutes the owner: the capture closes while Mia is still in earshot');
  assert(/Your mic is muted/.test(await s.eval(`document.querySelector('.talk-badge')?.innerText ?? ''`)), 'and the voice chip says the mic is muted');
  await s.key('keyDown', 'KeyV', 'v');
  await s.sleep(400);
  assert((await capture(s)) === 'closed', 'holding V does not open a muted mic');
  await s.key('keyUp', 'KeyV', 'v');

  await s.click(voices.x, voices.y);
  await s.waitFor(`${state}.voicesMuted`, 5000);
  await say(s, 'second line, muted');
  await s.sleep(200);
  assert(!(await spoken(s)).includes('second line, muted'), 'with voices muted, what Mia says is not spoken');
  assert((await s.eval(`${state}.bubbles.mia?.text`)) === 'second line, muted', 'but it still shows in her bubble');
  const bar = await s.eval(`[...document.querySelectorAll('[data-testid=mute-mic], [data-testid=mute-voices]')].map((b) => b.innerText + ':' + b.getAttribute('aria-pressed'))`);
  assert(bar.join() === 'Mic muted:true,Voices muted:true', `both switches show muted (${bar.join()})`);
  await s.eval(`document.activeElement?.blur()`);
  await s.press('Enter');
  await s.waitFor(`['chat-input', 'drawer-input'].includes(document.activeElement?.id)`, 3000).catch(() => {});
  const typing = await s.eval(`document.activeElement?.id || document.activeElement?.tagName`);
  assert(['chat-input', 'drawer-input'].includes(typing), `and Enter still focuses a chat input to type to Mia (${typing})`);
  await s.press('Escape');
  await s.shot('mute-both');

  await s.close();
  const again = await launch({ env });
  await setup(again);
  const kept = await again.eval(`({ mic: ${state}.micMuted, voices: ${state}.voicesMuted })`);
  assert(kept.mic === true && kept.voices === true, `both stay muted after a restart (${JSON.stringify(kept)})`);
  await companion(again);
  await again.sleep(1500);
  assert((await capture(again)) === 'closed', 'and the mic stays shut next to Mia after the restart');

  const on = await again.center('[data-testid=mute-mic]', 'Mic muted');
  await again.click(on.x, on.y);
  await again.waitFor(`${state}.voice.capture.kind === 'open'`, 15000);
  assert(!(await again.eval(`${state}.micMuted`)), 'a click on "Mic muted" turns the mic back on, and it opens next to Mia');
  const v = await again.center('[data-testid=mute-voices]', 'Voices muted');
  await again.click(v.x, v.y);
  await again.waitFor(`!${state}.voicesMuted`, 5000);
  await say(again, 'third line, heard again');
  assert((await spoken(again)).includes('third line, heard again'), 'and with voices back on, Mia is spoken again');
};

export const diagnose = async (s) => console.log('at failure:', JSON.stringify(await s.eval(`({ voice: ${state}.voice, talkingTo: ${state}.talkingTo, vis: document.visibilityState, micMuted: ${state}.micMuted })`).catch((e) => e.message)));
