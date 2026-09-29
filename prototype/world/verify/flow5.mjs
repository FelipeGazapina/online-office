export default async (s) => {
  await s.sleep(2000);
  await s.eval("__demo.auto = false");
  await s.eval(`(() => { const c = structuredClone(__office.store.getState().company); c.employees = c.employees.filter(e => e.name !== 'Theo'); __office.apply({ type: 'snapshot', company: c }); })()`);
  await s.sleep(800);
  console.log('avatars after fire:', await s.eval("__office.state().avatars.map(a => a.id).join(',')"));
  await s.eval(`(() => { const c = structuredClone(__office.store.getState().company); c.blocks.push({ id: 'b3', name: 'Docs', cwd: '/tmp/docs', color: '#c77dd4', slot: 2 }); __office.apply({ type: 'snapshot', company: c }); })()`);
  await s.eval("__office.setCamera('iso')");
  await s.sleep(2500);
  await s.shot('x-three-blocks');
};
