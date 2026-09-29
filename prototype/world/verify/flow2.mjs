export const preload = `
  window.__recStarts = 0;
  const R = window.webkitSpeechRecognition;
  if (R) { const st = R.prototype.start; R.prototype.start = function () { window.__recStarts++; return st.call(this); }; }
`;
const j = (v) => JSON.stringify(v);
export default async (s) => {
  await s.sleep(2000);
  await s.eval('window.__spoken = []; speechSynthesis.speak = (u) => { __spoken.push(u.text); };');

  // Mic-denied loop guard: proximity mic starts once near someone, fails (headless has no mic), and must not retry forever.
  await s.eval("__office.setCamera('follow'); __office.teleport(-12, -1.6, Math.PI); __office.step(1)");
  await s.sleep(2500);
  console.log('recognizer starts after 2.5s near Theo:', await s.eval('__recStarts'), 'note:', await s.eval('__office.store.getState().voice.note'));

  // Enter while standing next to Theo, with Sana asking: goes to Theo.
  await s.eval("__demo.ask('Sana'); __office.step(20)");
  await s.eval("__office.teleport(-12, -1.6, Math.PI); __office.step(1)");
  console.log('talkingTo', await s.eval("__office.store.getState().talkingTo"), 'asker', await s.eval("__office.store.getState().askerId"));
  await s.press('Enter');
  await s.type('write the README');
  await s.press('Enter');
  await s.sleep(500);
  console.log('toasts', await s.eval("[...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' / ')"));
  console.log('chat bar', await s.eval("document.querySelector('.chat .to')?.innerText"));
  await s.eval('__office.step(1)');
  console.log('spoken', await s.eval('JSON.stringify(__spoken)'));
  await s.shot('m-chat-and-card');

  // Speech from a far-away idle-at-desk employee is not spoken; a near one is.
  await s.eval("__office.teleport(-10, 7, Math.PI); __office.step(1)");
  await s.eval("__office.apply({ type: 'said', employeeId: 'e2', text: 'far words' })");
  await s.eval("__office.teleport(-12, -0.2, Math.PI); __office.step(1)");
  await s.eval("__office.apply({ type: 'said', employeeId: 'e2', text: 'near words' })");
  console.log('far spoken?', await s.eval("__spoken.includes('far words')"), 'near spoken?', await s.eval("__spoken.includes('near words')"));

  // Push to talk
  await s.eval("__office.store.setState({ mic: 'push' })");
  await s.eval("__office.teleport(-12, -1.6, Math.PI); __office.step(1)");
  await s.key('keyDown', 'KeyV', 'v');
  await s.sleep(300);
  console.log('ptt held, voice.active', await s.eval('__office.store.getState().voice.active'), 'starts', await s.eval('__recStarts'));
  await s.key('keyUp', 'KeyV', 'v');
  await s.sleep(300);
  console.log('ptt released, voice.active', await s.eval('__office.store.getState().voice.active'));

  // Real mouse: click Theo's tag, then the whiteboard.
  await s.eval("__office.store.setState({ selectedId: null, mic: 'proximity' }); __office.setCamera('follow'); __office.teleport(-12, 3, Math.PI); __office.step(1)");
  await s.sleep(2000);
  const tag = await s.eval("(() => { const r = [...document.querySelectorAll('.tag')].find(t => t.innerText.includes('Theo'))?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()");
  console.log('theo tag at', j(tag));
  if (tag) { await s.click(tag.x, tag.y); await s.sleep(300); console.log('selected after tag click', await s.eval('__office.store.getState().selectedId')); }
  await s.eval("__office.store.setState({ selectedId: null })");
  await s.shot('n-before-board-click');
  await s.click(640, 230);
  await s.sleep(400);
  console.log('modal after board click', j(await s.eval('__office.store.getState().modal')));
  await s.eval("__office.store.setState({ modal: null })");

  // A new hire walks in from the door.
  await s.eval(`(() => { const st = __office.store.getState(); const c = structuredClone(st.company); c.employees.push({ id: 'e9', name: 'Omar', provider: 'grok', blockId: 'b2', desk: 1, status: { kind: 'working', task: 'x', startedAt: Date.now() }, activity: 'Reading the code', hiredAt: Date.now() }); __office.apply({ type: 'snapshot', company: c }); })()`);
  await s.eval('__office.step(0.2)');
  await s.eval("__office.setCamera('iso')");
  await s.sleep(2500);
  console.log('omar just hired', j((await s.eval('__office.state()')).avatars.find((a) => a.id === 'e9')));
  await s.shot('o-hire-walk-in');
  await s.eval('__office.step(15)');
  console.log('omar after 15s', j((await s.eval('__office.state()')).avatars.find((a) => a.id === 'e9')));
};
