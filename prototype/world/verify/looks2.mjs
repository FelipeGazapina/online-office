export default async (s) => {
  await s.sleep(2000);
  await s.eval("__demo.auto = false; __office.setCamera('iso'); __office.teleport(-10, 3, Math.PI); __demo.ask('Mira'); __demo.ask('Sana'); __office.step(15)");
  await s.sleep(3500);
  await s.shot('t-iso-queue');
  await s.eval("__office.setCamera('first'); __office.teleport(-10, 3, Math.PI); __office.step(1)");
  await s.sleep(2500);
  await s.shot('u-first-queue-behind');
  await s.eval("__office.store.getState(); __office.teleport(-10, 3, 0); __office.step(0.1)");
  await s.sleep(2000);
  await s.shot('v-first-turned-around');
};
