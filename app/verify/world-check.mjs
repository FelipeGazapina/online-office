// Drives the real sim, runtime and store on a building without Electron. Run: node --no-warnings verify/world-check.mjs
globalThis.window = { office: { send() {} } };
globalThis.document = { hidden: false };
const src = '../src/renderer/src/';
const space = await import('../src/shared/space/index.ts');
const { get, set } = await import(`${src}store.ts`);
const { KEYS_INTENT, runtime } = await import(`${src}runtime.ts`);
const { IN_VIEW_HALF_ANGLE, stepSim, walkTo } = await import(`${src}sim.ts`);
const { openAt, worldFor } = await import(`${src}world.ts`);
const { LISTEN_RADIUS } = await import(`${src}audio.ts`);
const { check, finish } = await import('./check.ts');

const block = { id: 'b1', name: 'Block', cwd: '/work/b1', color: '#5b8def', slot: 0 };
const person = (id, name, seat) => ({ id, name, provider: 'claude-code', blockId: 'b1', seat, status: { kind: 'idle' }, activity: '', hiredAt: 0 });
const owner = runtime.owner;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p) => `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;
const step = (seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) stepSim(1 / 30);
};
const walking = () => owner.intent.kind === 'walk';
const legacy = space.legacyBuilding([{ id: 'b1', slot: 0 }], [{ id: 'ann', blockId: 'b1', desk: 1, orchestrator: false }]);
const ctx = { blocks: new Set(['b1']), employees: new Map([['ann', { blockId: 'b1', orchestrator: false }]]), seats: legacy.seats };
const annSeat = legacy.seats.get('ann');

function reset(building = legacy.building, people = [person('ann', 'Ann', annSeat)]) {
  runtime.avatars.clear();
  runtime.arrived.clear();
  runtime.seeded = false;
  runtime.keys.clear();
  owner.placed = false;
  owner.floor = 0;
  owner.climb = null;
  owner.vel.set(0, 0, 0);
  owner.speed = 0;
  owner.intent = KEYS_INTENT;
  owner.approach = null;
  owner.approachArrived = false;
  runtime.chatOpenable = null;
  set({ building, story: 0, company: { name: 'Test', level: 3, xp: 0, blocks: [block], employees: people }, talkingTo: null, askerId: null, meetingDoor: 'open' });
  step(0.1);
}

// Steps until the walk ends and reports whether the owner ever stood on ground that is not walkable.
function walkOut(seconds = 60) {
  const trace = { trespass: null, floors: new Set() };
  for (let i = 0; i < seconds * 30 && walking(); i++) {
    stepSim(1 / 30);
    const w = worldFor(get().building, get().meetingDoor);
    if (!owner.climb && !openAt(w, owner.floor, owner.pos.x, owner.pos.z)) trace.trespass ??= fmt(owner.pos);
    trace.floors.add(owner.floor);
  }
  return trace;
}

reset();
const world = worldFor(get().building, 'open');
check(owner.placed && owner.floor === 0 && openAt(world, 0, owner.pos.x, owner.pos.z), `the owner starts inside the front door on open ground ${fmt(owner.pos)}`);
const ann = runtime.avatars.get('ann');
const pose = space.seatPose(legacy.building, annSeat);
check(ann.seated && dist(ann.pos, pose.chair) < 0.05 && Math.abs(Math.sin(ann.yaw - pose.yaw)) < 0.1, 'an employee in the first snapshot sits in the chair of her desk item, facing the desk');

const target = { x: -11, z: -7.1 };
const line = Array.from({ length: 401 }, (_, i) => ({ x: owner.pos.x + ((target.x - owner.pos.x) * i) / 400, z: owner.pos.z + ((target.z - owner.pos.z) * i) / 400 }));
check(line.some((p) => !openAt(world, 0, p.x, p.z)), 'the straight line to the target goes through a desk, so the walk has to detour');
walkTo({ kind: 'point', at: target, floor: 0 });
check(walking() && owner.intent.goal.kind === 'point', 'walkTo on a point starts a walk');
const trace = walkOut();
check(!walking(), 'the walk ends by itself', `still walking at ${fmt(owner.pos)}`);
check(dist(owner.pos, target) < 0.15, 'the walk ends within 0.15 m of the target', `${dist(owner.pos, target).toFixed(3)} m away at ${fmt(owner.pos)}`);
check(trace.trespass === null, 'the owner never stands where the floor is not walkable', `at ${trace.trespass}`);
step(1);
check(owner.speed < 0.2 && !walking(), 'after the walk the owner stands still');

for (const key of ['KeyW', 'ArrowLeft', 'KeyS']) {
  reset();
  walkTo({ kind: 'point', at: { x: 5, z: 4.2 }, floor: 0 });
  step(1);
  runtime.keys.add(key);
  stepSim(1 / 30);
  check(owner.intent.kind === 'keys', `${key} held drops the walk on the next step`);
  runtime.keys.clear();
}

reset();
walkTo({ kind: 'employee', employeeId: 'ann' });
check(walking(), 'going to an employee starts a walk');
walkOut();
step(0.5);
check(dist(owner.pos, ann.pos) < LISTEN_RADIUS && get().talkingTo === 'ann', `it ends within earshot of her (${dist(owner.pos, ann.pos).toFixed(2)} m) and talking to her`);

console.log('# the meeting room door');
reset();
const room = worldFor(get().building, 'open').ownerRoom;
const inside = { x: room.bbox.x0 + 1.5, z: room.bbox.z0 + 1.5 };
check(room && room.doors.length === 2 && room.doorAt, 'the owner room has its door, found from the building');
set({ meetingDoor: 'closed' });
step(0.1);
walkTo({ kind: 'point', at: inside, floor: 0 });
check(!walking(), 'with the door closed there is no walk into the room');
set({ meetingDoor: 'open' });
step(0.1);
walkTo({ kind: 'point', at: inside, floor: 0 });
check(walking(), 'with the door open there is');
walkOut();
check(dist(owner.pos, inside) < 0.3, 'and the owner gets in');
set({ meetingDoor: 'closed' });
walkTo({ kind: 'point', at: { x: 5, z: 4.2 }, floor: 0 });
check(!walking(), 'shut in, there is no walk out');

console.log('# a new hire');
reset();
const hired = [person('ann', 'Ann', annSeat), person('bo', 'Bo', 'b1:bench_desk:02')];
set({ company: { ...get().company, employees: hired } });
step(0.1);
const bo = runtime.avatars.get('bo');
check(!bo.seated && dist(bo.pos, world.entry) < 2, 'a hire after the first snapshot walks in at the door');
step(60);
check(bo.seated && dist(bo.pos, space.seatPose(legacy.building, 'b1:bench_desk:02').chair) < 0.05, 'and sits down at the desk they were given');

console.log('# a second story');
const rect = { x: -4, z: 2, w: 8, h: 6 };
const ops = [
  { t: 'stories', count: 2 },
  space.paintRect(1, rect, space.PAINT.woodDark),
  { t: 'walls', story: 1, put: space.rectWalls(rect, 2).map((w) => (w.d === 'e' && w.z === 8 && w.x === 1 ? { ...w, open: 'door' } : w)), del: [] },
  { t: 'items', story: 0, put: [{ id: 'stairs:00', def: 'stairs', x: -4, z: 4, rot: 0 }], del: [] },
];
const built = space.applyOps(legacy.building, ops, ctx);
check(built.ok, 'the stairs and the second story are a legal build', built.ok ? '' : JSON.stringify(built.violations));
reset(built.building);
const up = { x: 0.5, z: 6.5 };
walkTo({ kind: 'point', at: up, floor: 1 });
check(walking() && owner.intent.trip.legs.length === 2, 'a walk to story 1 is planned as two legs, to the stairs and across the top');
let peak = 0;
for (let i = 0; i < 90 * 30 && walking(); i++) {
  stepSim(1 / 30);
  if (owner.floor === 0) peak = Math.max(peak, owner.pos.y);
}
check(peak > 1 && peak < 3.2, `the owner climbs: height rose to ${peak.toFixed(2)} m while still on story 0`);
check(!walking() && owner.floor === 1 && Math.abs(owner.pos.y - 3.2) < 0.01 && dist(owner.pos, up) < 0.2, `and arrives on story 1 at ${fmt(owner.pos)}, ${owner.pos.y.toFixed(2)} m up`);
step(0.2);
check(get().story === 1, 'the scene is told the owner is on story 1');
walkTo({ kind: 'point', at: { x: -3, z: 1 }, floor: 0 });
walkOut();
check(owner.floor === 0 && Math.abs(owner.pos.y) < 0.01, 'and walks back down to story 0');

console.log('# the chat drawer near an employee');
// A straight stretch of open floor that passes within `near` m of `at` and runs 3 m on each side of that closest point.
function passBy(at, near) {
  const w = worldFor(get().building, 'open');
  for (let k = 0; k < 32; k++) {
    const yaw = (2 * Math.PI * k) / 32;
    const f = { x: Math.sin(yaw), z: Math.cos(yaw) };
    for (const side of [1, -1]) {
      const mid = { x: at.x - f.z * near * side, z: at.z + f.x * near * side };
      const pts = Array.from({ length: 61 }, (_, i) => ({ x: mid.x + f.x * (i / 10 - 3), z: mid.z + f.z * (i / 10 - 3) }));
      if (pts.every((p) => openAt(w, 0, p.x, p.z))) return { from: pts[0], to: pts[60], yaw };
    }
  }
  return null;
}
const stand = (p, yaw) => {
  owner.pos.set(p.x, 0, p.z);
  owner.vel.set(0, 0, 0);
  owner.intent = KEYS_INTENT;
  owner.approach = null;
  owner.approachArrived = false;
  runtime.chatOpenable = null;
  runtime.view.yaw = yaw;
  owner.yaw = yaw;
};
const drawerCase = (camera) => {
  reset();
  set({ camera, selectedId: null, talkingTo: null });
  step(0.1);
};
const walkPast = (route) => {
  const seen = { talking: false, opened: null };
  stand(route.from, route.yaw);
  step(0.1);
  runtime.keys.add('KeyW');
  for (let i = 0; i < 4 * 30 && dist(owner.pos, route.from) < 5.6; i++) {
    stepSim(1 / 30);
    seen.talking ||= get().talkingTo === 'ann';
    seen.opened ??= get().selectedId;
  }
  runtime.keys.clear();
  step(0.5);
  return seen;
};

drawerCase('iso');
const annAt = { x: runtime.avatars.get('ann').pos.x, z: runtime.avatars.get('ann').pos.z };
const route = passBy(annAt, 1.1);
check(route !== null, `there is a straight stretch of open floor passing 1.1 m from Ann (${route ? fmt(route.from) + ' to ' + fmt(route.to) : 'none'})`);
const passed = walkPast(route);
check(passed.talking && passed.opened === null, 'iso: walking past a seated employee within 1.5 m makes her the one the owner talks to, but never opens her chat', `talking ${passed.talking}, drawer ${passed.opened}`);

drawerCase('iso');
walkTo({ kind: 'employee', employeeId: 'ann' });
check(owner.approach === 'ann', 'iso: walking to an employee remembers that the owner chose to go to her');
const early = { frames: 0, inRange: 0, drawer: null };
for (let i = 0; i < 60 * 30 && walking(); i++) {
  stepSim(1 / 30);
  if (!walking()) break;
  early.frames++;
  if (get().talkingTo === 'ann') early.inRange++;
  early.drawer ??= get().selectedId;
}
check(early.inRange > 0 && early.drawer === null, `iso: while the walk to her lasts her chat stays shut, even on the ${early.inRange} of ${early.frames} walking frames she is already in range`, `drawer ${early.drawer} while walking`);
check(!walking() && get().selectedId === 'ann', 'iso: the frame the walk ends, her chat opens', `walking ${walking()}, drawer ${get().selectedId}`);
step(0.5);
check(get().selectedId === 'ann' && owner.approach === null, 'iso: on arrival her chat opens and the approach is spent', `drawer ${get().selectedId}, approach ${owner.approach}`);

drawerCase('iso');
walkTo({ kind: 'employee', employeeId: 'ann' });
step(0.5);
runtime.keys.add('KeyS');
stepSim(1 / 30);
runtime.keys.clear();
check(owner.approach === null, 'iso: a steering key during the walk to her drops the approach');
const back = passBy(annAt, 1.1);
walkPast(back);
check(get().selectedId === null, 'iso: so a later pass within range does not open her chat', `drawer ${get().selectedId}`);

drawerCase('iso');
walkTo({ kind: 'employee', employeeId: 'ann' });
step(0.3);
owner.intent = KEYS_INTENT;
step(0.2);
check(owner.approach === null, 'iso: a walk to her dropped between two frames, as a tapped key does in input.ts, drops the approach too');

drawerCase('iso');
walkTo({ kind: 'employee', employeeId: 'ann' });
step(0.5);
walkTo({ kind: 'point', at: { x: 5, z: 4.2 }, floor: 0 });
check(owner.approach === null, 'iso: a walk to a point replaces the approach');

drawerCase('iso');
stand(route.from, route.yaw);
step(0.2);
set({ selectedId: 'ann' });
const nearAnn = passBy(annAt, 1.0);
stand({ x: (nearAnn.from.x + nearAnn.to.x) / 2, z: (nearAnn.from.z + nearAnn.to.z) / 2 }, nearAnn.yaw);
step(1);
check(get().talkingTo === 'ann' && get().selectedId === 'ann', 'iso: Open chat still opens the drawer and the sim leaves it open while the owner is in range', `talking ${get().talkingTo}, drawer ${get().selectedId}`);

// First person: in view means within PI/4 of where the owner looks.
const beside = { x: (route.from.x + route.to.x) / 2, z: (route.from.z + route.to.z) / 2 };
const toward = Math.atan2(annAt.x - beside.x, annAt.z - beside.z);
drawerCase('first');
stand(beside, toward + Math.PI);
step(1);
check(get().talkingTo === 'ann' && get().selectedId === null, 'first: in range but facing away, the owner talks to her and no chat opens', `talking ${get().talkingTo}, drawer ${get().selectedId}`);
runtime.view.yaw = toward + IN_VIEW_HALF_ANGLE + 0.15;
step(0.2);
check(get().selectedId === null, 'first: just outside PI/4 of the look direction, still no chat');
runtime.view.yaw = toward + IN_VIEW_HALF_ANGLE - 0.15;
step(0.2);
check(get().selectedId === 'ann', 'first: turning to face her while in range opens her chat', `drawer ${get().selectedId}`);

set({ selectedId: null });
step(2);
runtime.view.yaw = toward;
step(1);
check(get().selectedId === null, 'after Esc closes it, standing in range and in view does not reopen it', `drawer ${get().selectedId}`);

drawerCase('first');
// Open floor straight toward her, from 3 m out to 1 m short of her.
const approachLine = (() => {
  const w = worldFor(get().building, 'open');
  for (let k = 0; k < 32; k++) {
    const yaw = (2 * Math.PI * k) / 32;
    const from = { x: annAt.x - Math.sin(yaw) * 3, z: annAt.z - Math.cos(yaw) * 3 };
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: from.x + Math.sin(yaw) * i * 0.1, z: from.z + Math.cos(yaw) * i * 0.1 }));
    if (pts.every((p) => openAt(w, 0, p.x, p.z))) return { from, yaw };
  }
  return null;
})();
check(approachLine !== null, `there is open floor to walk straight up to her${approachLine ? ' from ' + fmt(approachLine.from) : ''}`);
const facing = approachLine.yaw;
stand(approachLine.from, facing);
step(0.2);
check(get().talkingTo === null, 'first: 3 m out she is not in range yet');
runtime.keys.add('KeyW');
for (let i = 0; i < 3 * 30 && get().talkingTo !== 'ann'; i++) stepSim(1 / 30);
runtime.keys.clear();
step(0.3);
check(get().talkingTo === 'ann' && get().selectedId === 'ann', 'first: walking up to her while facing her opens her chat', `talking ${get().talkingTo}, drawer ${get().selectedId}`);
stand(approachLine.from, facing);
step(0.5);
check(get().talkingTo === null && get().selectedId === null, 'leaving range closes a chat that proximity opened, as before', `talking ${get().talkingTo}, drawer ${get().selectedId}`);
set({ camera: 'iso' });

finish();
