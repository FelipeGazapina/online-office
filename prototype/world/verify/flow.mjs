const j = (v) => JSON.stringify(v);
export default async (s) => {
  await s.sleep(2000);
  await s.eval('window.__spoken = []; speechSynthesis.speak = (u) => { __spoken.push(u.text); };');
  await s.eval("__office.setCamera('follow'); __office.teleport(-10, 3, Math.PI)");
  await s.eval("__demo.ask('Mira')");
  await s.eval('__office.step(1)');
  await s.eval("__demo.ask('Sana')");
  await s.eval('__office.step(14)');
  console.log('queue state', await s.eval('JSON.stringify(__office.state())'));
  console.log('spoken after arrival', await s.eval('JSON.stringify(__spoken)'));
  await s.sleep(1500);
  console.log('card', await s.eval("document.querySelector('.qcard')?.innerText.replace(/\\n/g,' | ')"));
  await s.shot('d-queue');

  await s.eval("document.querySelector('.qcard .opts button').click()");
  await s.eval('__office.step(12)');
  console.log('after answer', await s.eval('JSON.stringify(__office.state())'));
  console.log('spoken', await s.eval('JSON.stringify(__spoken)'));
  console.log('toasts', await s.eval("[...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' / ')"));
  await s.sleep(800);
  await s.shot('e-second');

  await s.eval("__office.hold('KeyD', true); __office.step(3); __office.hold('KeyD', false); __office.step(3)");
  console.log('after walking east', await s.eval('JSON.stringify(__office.state())'));
  await s.sleep(1500);
  await s.shot('f-walk');

  await s.eval("__office.setCamera('follow'); __office.teleport(-12, -1.6, Math.PI)");
  await s.eval('__office.step(1)');
  await s.sleep(1500);
  console.log('proximity', await s.eval('JSON.stringify(__office.state())'));
  console.log('badge', await s.eval("document.querySelector('.talk-badge')?.innerText"));
  await s.shot('g-proximity');
  await s.press('Enter');
  await s.type('please write the README');
  await s.press('Enter');
  await s.eval('__office.step(0.5)');
  await s.sleep(500);
  console.log('toasts', await s.eval("[...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' / ')"));
  console.log('spoken', await s.eval('JSON.stringify(__spoken)'));

  await s.eval("__office.teleport(-10, 7, Math.PI); __office.step(1)");
  await s.eval("__office.apply({ type: 'said', employeeId: 'e3', text: 'far away words' })");
  console.log('far said spoken?', await s.eval("__spoken.includes('far away words')"));

  await s.eval("__office.set({ selectedId: 'e1' })");
  await s.sleep(500);
  await s.shot('h-drawer');
  await s.eval("__office.set({ selectedId: null, modal: { kind: 'whiteboard', blockId: 'b1' } })");
  await s.sleep(1500);
  await s.shot('i-whiteboard');
  await s.eval("__office.set({ modal: { kind: 'hire' } })");
  await s.sleep(400);
  await s.shot('j-hire');
  await s.eval("__office.set({ modal: null, helpOpen: true })");
  await s.sleep(300);
  await s.shot('k-help');
  await s.eval("__office.set({ helpOpen: false, demo: false, conn: 'offline', retryAt: Date.now() + 5000 })");
  await s.sleep(500);
  await s.shot('l-offline');
};
