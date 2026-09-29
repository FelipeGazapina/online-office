// Drives the real sim, runtime and store without Electron. Run: node --no-warnings verify/walk-check.mjs
globalThis.window = { office: { send() {} } };
globalThis.document = { hidden: false };
const src = '../src/renderer/src/';
const { get, set } = await import(`${src}store.ts`);
const { KEYS_INTENT, runtime } = await import(`${src}runtime.ts`);
const { stepSim, walkTo } = await import(`${src}sim.ts`);
const { angleDiff, deskPose, getLayout, MEETING_ROOM, OWNER_RADIUS, OWNER_START, WALL_MARGIN, withMeetingRoom } = await import(`${src}layout.ts`);
const { LISTEN_RADIUS } = await import(`${src}audio.ts`);
const { check, finish } = await import('./check.ts');

const TALK_REPLAN = 1.35;
const block = { id: 'b1', name: 'Block', cwd: '/work/b1', color: '#5b8def', slot: 0 };
const person = (id, name, desk) => ({ id, name, provider: 'claude-code', blockId: 'b1', desk, status: { kind: 'idle' }, activity: '', hiredAt: 0 });
const layout = getLayout([block]);
const owner = runtime.owner;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p) => `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;
const step = (seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) stepSim(1 / 30);
};
const walking = () => owner.intent.kind === 'walk';
const dest = () => (walking() ? owner.intent.path.at(-1) : null);
const grown = (by) => withMeetingRoom(layout, get().meetingDoor).obstacles.map((b) => ({ cx: b.cx, cz: b.cz, hw: b.hw + by, hd: b.hd + by }));
const inside = (p, boxes) => boxes.find((b) => Math.abs(p.x - b.cx) < b.hw && Math.abs(p.z - b.cz) < b.hd);

function reset(people = [person('ann', 'Ann', 1)]) {
  runtime.avatars.clear();
  runtime.arrived.clear();
  runtime.seeded = false;
  runtime.keys.clear();
  owner.pos.set(OWNER_START.x, 0, OWNER_START.z);
  owner.vel.set(0, 0, 0);
  owner.yaw = Math.PI;
  owner.speed = 0;
  owner.intent = KEYS_INTENT;
  runtime.queueYaw = Math.PI;
  runtime.view.yaw = Math.PI;
  set({ company: { name: 'Test', level: 3, xp: 0, blocks: [block], employees: people }, talkingTo: null, askerId: null, meetingDoor: 'open' });
  step(0.1);
}

// Steps until the walk ends and reports what happened on the way.
function walkOut(seconds = 40) {
  const trace = { peak: 0, trespass: null, outside: null, replans: new Set() };
  const walls = { x0: layout.bounds.x0 + WALL_MARGIN - 1e-6, x1: layout.bounds.x1 - WALL_MARGIN + 1e-6, z0: layout.bounds.z0 + WALL_MARGIN - 1e-6, z1: layout.bounds.z1 - WALL_MARGIN + 1e-6 };
  const near = grown(OWNER_RADIUS - 0.05);
  for (let i = 0; i < seconds * 30 && walking(); i++) {
    stepSim(1 / 30);
    trace.peak = Math.max(trace.peak, owner.speed);
    trace.trespass ??= inside(owner.pos, near) ? fmt(owner.pos) : null;
    trace.outside ??= owner.pos.x < walls.x0 || owner.pos.x > walls.x1 || owner.pos.z < walls.z0 || owner.pos.z > walls.z1 ? fmt(owner.pos) : null;
    if (walking()) trace.replans.add(JSON.stringify(dest()));
  }
  return trace;
}

const target = { x: -12, z: -4.8 };
const straightCrossesDesk = Array.from({ length: 401 }, (_, i) => ({ x: OWNER_START.x + ((target.x - OWNER_START.x) * i) / 400, z: OWNER_START.z + ((target.z - OWNER_START.z) * i) / 400 })).some((p) => inside(p, grown(OWNER_RADIUS)));
check(straightCrossesDesk, 'the straight line from the start to the target goes through a desk, so the walk has to detour');

reset();
walkTo({ kind: 'point', at: target });
check(walking() && owner.intent.goal.kind === 'point', 'walkTo on a point starts a walk');
const trace = walkOut();
check(!walking(), 'the walk ends by itself', `still walking at ${fmt(owner.pos)}`);
check(dist(owner.pos, target) < 0.15, 'the walk ends within 0.15 m of the target', `${dist(owner.pos, target).toFixed(3)} m away at ${fmt(owner.pos)}`);
check(trace.trespass === null, 'the owner never sits inside an obstacle grown by 0.3 on the way', `at ${trace.trespass}`);
check(trace.outside === null, 'the owner never leaves the bounds inset by the wall margin', `at ${trace.outside}`);
step(1);
check(owner.speed < 0.2 && !walking(), 'after the walk the owner stands still and does not start again', `speed ${owner.speed.toFixed(2)}`);
check(dist(owner.pos, target) < 0.1, 'the owner comes to rest within 0.1 m of the target, so the walk does not overshoot', `${dist(owner.pos, target).toFixed(3)} m away`);

for (const key of ['KeyW', 'ArrowLeft', 'KeyS', 'ArrowDown']) {
  reset();
  walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
  step(1);
  runtime.keys.add(key);
  stepSim(1 / 30);
  check(owner.intent.kind === 'keys', `${key} held drops the walk on the next step`);
  runtime.keys.delete(key);
  step(1);
  const rest = { x: owner.pos.x, z: owner.pos.z };
  step(1);
  check(owner.speed < 0.2 && dist(owner.pos, rest) < 0.01, `after ${key} is released the owner stays put and does not resume the walk`);
}

reset();
walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
runtime.keys.add('ShiftLeft');
stepSim(1 / 30);
runtime.keys.delete('ShiftLeft');
check(walking(), 'Shift alone does not cancel a walk');

reset();
runtime.keys.add('KeyD');
walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
stepSim(1 / 30);
check(owner.intent.kind === 'keys', 'a walk started while a steering key is down loses to the key');
runtime.keys.clear();

reset();
walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
const walked = walkOut();
reset();
walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
runtime.keys.add('ShiftLeft');
const ran = walkOut();
step(1);
check(dist(owner.pos, { x: 5, z: 4.2 }) < 0.1, 'a run comes to rest within 0.1 m of the target too', `${dist(owner.pos, { x: 5, z: 4.2 }).toFixed(3)} m away`);
runtime.keys.clear();
check(walked.peak < 3.2, `without Shift the peak speed stays under 3.2 m/s (${walked.peak.toFixed(2)})`);
check(ran.peak > 4.5, `with Shift held the peak speed is above 4.5 m/s (${ran.peak.toFixed(2)})`);

reset();
const ann = () => runtime.avatars.get('ann');
walkTo({ kind: 'employee', employeeId: 'ann' });
check(walking() && owner.intent.goal.kind === 'employee', 'walkTo on an employee starts a walk');
const visit = walkOut();
check(!walking() && dist(owner.pos, ann().pos) <= LISTEN_RADIUS, 'going to an employee ends within earshot of them', `${dist(owner.pos, ann().pos).toFixed(2)} m`);
check(get().talkingTo === 'ann', 'the owner is talking to that employee on arrival', String(get().talkingTo));
check(visit.replans.size === 1, 'a walk to an employee who stays put never changes its destination', `${visit.replans.size} destinations`);
check(visit.trespass === null && visit.outside === null, 'the walk to an employee stays clear of obstacles and inside the bounds');
step(1.5);
const bearing = Math.atan2(ann().pos.x - owner.pos.x, ann().pos.z - owner.pos.z);
check(Math.abs(angleDiff(owner.yaw, bearing)) < 0.3, 'the owner faces the employee after arriving', `${angleDiff(owner.yaw, bearing).toFixed(2)} rad off`);

reset();
walkTo({ kind: 'employee', employeeId: 'ann' });
step(0.5);
const before = dest();
ann().seated = false;
ann().pos.x += 4;
stepSim(1 / 30);
check(dist(dest(), ann().pos) <= TALK_REPLAN, 'when the employee moves away the walk is planned again to end near them', `${dist(dest(), ann().pos).toFixed(2)} m from them`);
check(dist(dest(), before) > 2, 'the new destination is not the old one', `${fmt(before)} then ${fmt(dest())}`);
walkOut();
check(get().talkingTo === 'ann', 'the walk that followed a moving employee still ends talking to them', String(get().talkingTo));

reset([person('ann', 'Ann', 1), person('bob', 'Bob', 2)]);
runtime.avatars.get('ann').pos.set(-8, 0, 1);
runtime.avatars.get('bob').pos.set(-6.8, 0, 1);
owner.pos.set(-11, 0, 1);
walkTo({ kind: 'employee', employeeId: 'bob' });
const bob = runtime.avatars.get('bob').pos;
const other = runtime.avatars.get('ann').pos;
const spot = dest();
check(dist(spot, other) - dist(spot, bob) >= 0.3, 'with someone 1.2 m from the target, the planned spot is where the target is clearly nearest', `${dist(spot, other).toFixed(2)} m from the other, ${dist(spot, bob).toFixed(2)} m from the target`);
walkOut();
check(get().talkingTo === 'bob', 'so the owner ends up talking to the target and not the person next to them', String(get().talkingTo));

reset();
walkTo({ kind: 'employee', employeeId: 'ann' });
step(0.5);
set({ company: { ...get().company, employees: [] } });
stepSim(1 / 30);
check(owner.intent.kind === 'keys', 'when the employee leaves the office the walk is dropped');

reset();
walkTo({ kind: 'point', at: { x: 5, z: 4.2 } });
const kept = owner.intent;
walkTo({ kind: 'employee', employeeId: 'nobody' });
check(owner.intent === kept, 'walkTo for someone who is not in the office changes nothing');

const inDesk = deskPose(0, 1).desk;
reset();
walkTo({ kind: 'point', at: inDesk });
walkOut();
check(!inside(owner.pos, grown(OWNER_RADIUS - 0.05)) && dist(owner.pos, inDesk) < 2, 'a click in the middle of a desk walks to the nearest free floor', `ended at ${fmt(owner.pos)}`);

const asking = { kind: 'blocked_on_owner', task: 'a task', question: { id: 'q1', kind: 'ask', text: 'which one?', askedAt: 1 } };
const chair = deskPose(0, 0).chair;
const setStatus = (status) => set({ company: { ...get().company, employees: [{ ...get().company.employees[0], status }] } });
const inRoom = (p) => p.x > MEETING_ROOM.x0 && p.x < MEETING_ROOM.x1 && p.z > MEETING_ROOM.z0 && p.z < MEETING_ROOM.z1;

// Runs the world until `done`, noting the first time the employee stands where an avatar cannot: inside an obstacle
// grown by 0.25, which is the 0.3 body less some slack.
function until(done, seconds) {
  const seen = { trespass: null, entered: false };
  for (let i = 0; i < seconds * 30; i++) {
    stepSim(1 / 30);
    seen.trespass ??= ann() && inside(ann().pos, grown(0.25)) ? fmt(ann().pos) : null;
    seen.entered ||= !!ann() && inRoom(ann().pos);
    if (done()) return { ...seen, done: true, seconds: i / 30 };
  }
  return { ...seen, done: false, seconds };
}

function hireLater(desk = 0) {
  reset([]);
  set({ company: { ...get().company, employees: [person('ann', 'Ann', desk)] } });
  stepSim(1 / 30);
}

hireLater();
check(!ann().seated && dist(ann().pos, chair) > 8, 'a later hire starts at the door, far from the desk', fmt(ann().pos));
const hired = until(() => ann().seated, 60);
check(hired.done && dist(ann().pos, chair) < 0.05, 'a new hire walks past the meeting room and sits at its desk', `at ${fmt(ann().pos)} after ${hired.seconds.toFixed(0)} s`);
check(hired.trespass === null, 'the new hire never stands inside a wall or a desk on the way', `at ${hired.trespass}`);

for (const [where, owns] of [['outside the room', OWNER_START], ['inside the room, at his desk', { x: -16.5, z: 5.9 }]]) {
  hireLater();
  until(() => ann().seated, 60);
  owner.pos.set(owns.x, 0, owns.z);
  step(0.5);
  setStatus(asking);
  const came = until(() => get().askerId === 'ann', 90);
  check(came.done, `a blocked employee reaches the owner ${where}`, `at ${fmt(ann().pos)} after ${came.seconds.toFixed(0)} s`);
  check(came.trespass === null, `on the way to the owner ${where} it never stands inside a wall or a desk`, `at ${came.trespass}`);
  check(came.entered === inRoom(owner.pos), `it enters the meeting room exactly when the owner is inside it (${where})`, `entered ${came.entered}`);
  setStatus({ kind: 'idle' });
  const back = until(() => ann().seated, 90);
  check(back.done && dist(ann().pos, chair) < 0.05, `once released it walks back and sits at its desk again (owner ${where})`, `at ${fmt(ann().pos)} after ${back.seconds.toFixed(0)} s`);
  check(back.trespass === null, `on the way back to the desk it never stands inside a wall or a desk (owner ${where})`, `at ${back.trespass}`);
}

hireLater();
until(() => ann().seated, 60);
owner.pos.set(-16.5, 0, 5.9);
set({ meetingDoor: 'closed' });
step(0.5);
setStatus(asking);
const shut = until(() => get().askerId === 'ann' || !ann().seated, 30);
check(!shut.done && ann().seated && get().askerId === null, 'with the door closed a blocked employee waits at its desk', `at ${fmt(ann().pos)}`);
check(dist(ann().pos, chair) < 0.05, 'and it stays exactly at its chair', `at ${fmt(ann().pos)}`);
set({ meetingDoor: 'open' });
const opened = until(() => get().askerId === 'ann', 90);
check(opened.done && opened.entered, 'once the door opens it walks in through the door and arrives', `at ${fmt(ann().pos)} after ${opened.seconds.toFixed(0)} s`);
check(opened.trespass === null, 'and it never stands inside a wall on the way', `at ${opened.trespass}`);

hireLater();
until(() => ann().seated, 60);
owner.pos.set(-16.5, 0, 5.9);
step(0.5);
setStatus(asking);
until(() => get().askerId === 'ann' && inRoom(ann().pos), 90);
set({ meetingDoor: 'closed' });
setStatus({ kind: 'idle' });
const locked = until(() => ann().seated, 20);
check(!locked.done && inRoom(ann().pos) && locked.trespass === null, 'an employee inside the room when the door shuts stays inside and never goes through the wall', `at ${fmt(ann().pos)}`);
check(ann().speed < 0.05, 'while locked in it stands still and does not walk into the wall', `speed ${ann().speed.toFixed(2)}`);
set({ meetingDoor: 'open' });
const out = until(() => ann().seated, 90);
check(out.done && dist(ann().pos, chair) < 0.05 && out.trespass === null, 'and once the door opens it walks out and sits at its desk', `at ${fmt(ann().pos)} after ${out.seconds.toFixed(0)} s`);
const nearDoor = { x: MEETING_ROOM.x1 + 0.6, z: MEETING_ROOM.doorZ };

reset();
set({ meetingDoor: 'closed' });
const room = { x: -14, z: 5 };
walkTo({ kind: 'point', at: room });
check(!walking(), 'a click inside a room whose door is closed changes nothing');
set({ meetingDoor: 'open' });
walkTo({ kind: 'point', at: room });
check(walking(), 'with the door open the same click starts a walk');
walkOut();
check(dist(owner.pos, room) < 0.15 && inRoom(owner.pos), 'and the owner walks in through the door to the spot', `at ${fmt(owner.pos)}`);
walkTo({ kind: 'point', at: nearDoor });
step(0.2);
set({ meetingDoor: 'closed' });
stepSim(1 / 30);
check(!walking(), 'when the door shuts under a walk that has to go through it, the walk is dropped');

reset();
set({ company: null });
runtime.view.yaw = Math.PI;
runtime.keys.add('KeyW');
step(1);
runtime.keys.delete('KeyW');
runtime.keys.add('KeyD');
step(0.5);
runtime.keys.delete('KeyD');
step(0.5);
const keysOnly = { x: owner.pos.x, z: owner.pos.z };
check(Math.abs(keysOnly.x + 8.500502741724066) < 1e-3 && Math.abs(keysOnly.z - 1.2000012492610947) < 1e-3, 'walking with the keys covers the same ground as before click walking existed', fmt(keysOnly));
runtime.keys.add('ShiftLeft');
runtime.keys.add('KeyW');
step(1);
check(Math.abs(owner.pos.x + 8.500000003088955) < 1e-3 && Math.abs(owner.pos.z + 3.834018187966559) < 1e-3, 'running with the keys covers the same ground as before click walking existed', fmt(owner.pos));
runtime.keys.clear();

finish();
