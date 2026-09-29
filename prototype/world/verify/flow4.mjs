const j = (v) => JSON.stringify(v);
export default async (s) => {
  await s.sleep(2000);
  await s.eval("__demo.auto = false");
  const st = () => s.eval('__office.state().owner');
  await s.eval("__office.setCamera('follow'); __office.teleport(-10, 6, Math.PI); __office.step(0.5)");
  const a = await st();
  await s.eval("__office.hold('KeyW'); __office.step(1); __office.hold('KeyW', false); __office.step(1)");
  const b = await st();
  console.log('walk 1s distance (m):', Math.hypot(b.x - a.x, b.z - a.z).toFixed(2));
  await s.eval("__office.hold('KeyW'); __office.hold('ShiftLeft'); __office.step(1); __office.hold('KeyW', false); __office.hold('ShiftLeft', false); __office.step(1)");
  const c = await st();
  console.log('run 1s distance (m):', Math.hypot(c.x - b.x, c.z - b.z).toFixed(2));
  await s.eval("__office.hold('ArrowLeft'); __office.step(3); __office.hold('ArrowLeft', false); __office.step(1)");
  console.log('arrows work, owner x:', (await st()).x.toFixed(2));
  await s.eval("__office.teleport(-10, 8.9, 0); __office.hold('KeyS'); __office.step(3); __office.hold('KeyS', false); __office.step(0.5)");
  console.log('clamped at south wall, z:', (await st()).z.toFixed(2), '(bound 8.4)');

  await s.eval("__office.setCamera('first'); __office.teleport(-10, 3, Math.PI); __office.step(0.5)");
  await s.sleep(800);
  const y0 = await s.eval('__office.state().owner.yaw');
  await s.call?.('x');
  await s.eval('0');
  // drag to look
  await s.click(640, 400);
  console.log('first person click ok');

  // interject styles to a working employee (Sana at her desk)
  await s.eval("__office.setCamera('follow'); __office.teleport(-3.2, -1.3, Math.PI); __office.step(1)");
  console.log('talking to', await s.eval('__office.store.getState().talkingTo'));
  for (const style of ['next', 'now']) {
    await s.eval(`__office.store.setState({ interrupt: '${style}' })`);
    await s.press('Enter');
    await s.type(`use ${style} please`);
    await s.press('Enter');
    await s.sleep(200);
  }
  console.log('sana log:', j(await s.eval("__office.store.getState().logs['e3']?.map(l => l.line).filter(l => l.includes('interject'))")));
  console.log('toasts:', await s.eval("[...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' / ')"));
  await s.shot('w-interject');
};
