export default async (s) => {
  await s.sleep(2500);
  await s.eval('__office.step(1)');
  await s.sleep(1500);
  await s.shot('a-follow');
  await s.eval("__office.setCamera('iso')");
  await s.sleep(3000);
  await s.shot('b-iso');
  await s.eval("__office.setCamera('first'); __office.teleport(-12, 3, Math.PI)");
  await s.sleep(2500);
  await s.shot('c-first');
  const fps = await s.eval('new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : res(n); }; requestAnimationFrame(f); })');
  console.log('fps', fps);
};
