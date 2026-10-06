// The whole per-frame world loop in one place: owner movement, employee walking, the queue,
// proximity listening and the arrival moment. Avatar targets are derived from the office's
// logical state every frame: blocked_on_owner walks to the owner, everything else goes to the desk. Everyone follows
// routes planned on the nav grid, so the walls of the meeting room are in the way of employees as much as of the owner.
import { Vector3 } from 'three';
import type { BlockId, Company, Employee, EmployeeId } from '../../shared/protocol.ts';
import type { Board, Task } from '../../shared/tasks.ts';
import { blocksWithTasks } from './boardView.ts';
import { announceArrival, cancelSpeech, LISTEN_RADIUS } from './audio.ts';
import { KEYS_INTENT, runtime, STEER_KEYS, type AvatarRT, type OwnerIntent, type WalkGoal } from './runtime.ts';
import { get, set, toast, waitingQueue } from './store.ts';
import { ownerInsideMeetingRoom } from './meeting.ts';
import { angleDiff } from './util.ts';
import {
  approachTo,
  climbHeight,
  floorBase,
  openAt,
  ownerSeat,
  seatOf,
  standable,
  terminalStand,
  tripTo,
  whiteboardAt,
  worldFor,
  type FloorPos,
  type SeatPose,
  type StairLink,
  type Trip,
  type Vec2,
  type World,
} from './world.ts';

const OWNER_WALK = 3.0;
const OWNER_RUN = 5.4;
const EMPLOYEE_WALK = 1.4;
const QUEUE_SPACING = 1.2;
const LISTEN_EXIT = LISTEN_RADIUS + 0.3;
// Where the owner stands when walking to someone.
const TALK_SPOT = 1.0;
// A walk to someone is planned again once it would end this far from them. TALK_REPLAN + ARRIVE stays under
// LISTEN_RADIUS, so a walk always ends within earshot.
const TALK_REPLAN = 1.35;
// The owner has arrived within this distance of the last waypoint, and moves on from the others within CORNER.
const ARRIVE = 0.1;
const CORNER = 0.2;
// An avatar plans its route again once its target has moved this far since the plan.
const REROUTE = 0.5;
const TASK_BOARD_RADIUS = 1.75;
// A climb ends this close to the top of the stairs.
const CLIMB_DONE = 0.2;
// A seated avatar further than this from its chair has had the desk moved from under it.
const SEATED_DRIFT = 0.05;

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export function queueSlot(k: number): Vec2 {
  const { pos } = runtime.owner;
  const f = { x: Math.sin(runtime.queueYaw), z: Math.cos(runtime.queueYaw) };
  const r = { x: -f.z, z: f.x };
  const back = QUEUE_SPACING * (k + 1);
  const side = k % 2 === 0 ? 0.75 : -0.75;
  return { x: pos.x - f.x * back + r.x * side, z: pos.z - f.z * back + r.z * side };
}

export function seatFor(e: Employee, world: World): SeatPose {
  return seatOf(world, e) ?? fallbackSeat(world);
}

// Whoever has no desk waits by the front door.
function fallbackSeat(world: World): SeatPose {
  const { entry } = world;
  return {
    floor: entry.floor,
    desk: { x: entry.x + 3, z: entry.z - 1.5 },
    chair: { x: entry.x + 3, z: entry.z - 0.5 },
    exit: { x: entry.x + 3, z: entry.z + 0.5 },
    yaw: Math.PI,
  };
}

export function taskBoardTarget(company: Company, boards: readonly Board[], tasks: readonly Task[], world: World, pos: Vector3, floor: number): BlockId | null {
  let nearest: { id: BlockId; distance: number } | undefined;
  const withTasks = blocksWithTasks(boards, tasks);
  for (const block of company.blocks) {
    if (!withTasks.has(block.id) && !block.linearBoardUrl) continue;
    const board = whiteboardAt(world, block.id);
    if (!board || board.floor !== floor) continue;
    const distance = dist2(pos, board.at);
    if (distance >= TASK_BOARD_RADIUS || (nearest && distance >= nearest.distance)) continue;
    nearest = { id: block.id, distance };
  }
  return nearest?.id ?? null;
}

function syncAvatars(company: Company, world: World) {
  const ids = new Set(company.employees.map((e) => e.id as string));
  for (const id of [...runtime.avatars.keys()]) {
    if (ids.has(id)) continue;
    runtime.avatars.delete(id);
    runtime.arrived.delete(id);
  }
  for (const e of company.employees) {
    if (runtime.avatars.has(e.id)) continue;
    // First snapshot: the team is already at work. Later hires walk in through the door.
    const seat = seatFor(e, world);
    const seated = !runtime.seeded;
    const floor = seated ? seat.floor : world.entry.floor;
    const start = seated ? seat.chair : { x: world.entry.x, z: world.entry.z + 0.6 };
    runtime.avatars.set(e.id, {
      id: e.id,
      pos: new Vector3(start.x, floorBase(floor), start.z),
      floor,
      climb: null,
      yaw: seated ? seat.yaw : Math.PI,
      speed: 0,
      seated,
      leaving: false,
      route: null,
    });
  }
  runtime.seeded = true;
}

type Walk = Extract<OwnerIntent, { kind: 'walk' }>;
type Mover = { pos: Vector3; floor: number; climb: StairLink | null };

// The office a walk was planned in. A door that opens or closes, or an edit to the building, makes the plan stale.
const plannedIn = new WeakMap<Walk, World>();

const here = (m: Mover): FloorPos => ({ floor: m.floor, x: m.pos.x, z: m.pos.z });

// The next point `m` heads for on its trip, or null once the trip is done. Waypoints it has reached are dropped. At the
// foot of a staircase it starts the climb, and at the top it steps onto the next floor.
function nextAim(m: Mover, trip: Trip, arrive: number): { at: Vec2; final: boolean } | null {
  for (let guard = 0; guard < 8; guard++) {
    const leg = trip.legs[0];
    if (!leg) return null;
    if (m.climb) {
      if (dist2(m.pos, m.climb.to.at) >= CLIMB_DONE) return { at: m.climb.to.at, final: false };
      m.floor = m.climb.to.floor;
      m.pos.y = floorBase(m.floor);
      m.climb = null;
      trip.legs.shift();
      continue;
    }
    const lastLeg = trip.legs.length === 1;
    while (leg.path.length > 0) {
      const last = leg.path.length === 1 && lastLeg;
      if (dist2(m.pos, leg.path[0]) >= (last ? arrive : CORNER)) break;
      leg.path.shift();
    }
    if (leg.path.length > 0) return { at: leg.path[0], final: leg.path.length === 1 && lastLeg };
    if (!leg.via) return null;
    m.climb = leg.via;
  }
  return null;
}

export function tripEnd(trip: Trip): { floor: number; at: Vec2; legs: number; waypoints: number } {
  const last = trip.legs[trip.legs.length - 1];
  const at = last?.path[last.path.length - 1] ?? { x: trip.to.x, z: trip.to.z };
  return { floor: last?.floor ?? trip.to.floor, at, legs: trip.legs.length, waypoints: trip.legs.reduce((n, l) => n + l.path.length, 0) };
}

function plan(goal: WalkGoal, world: World): Walk | null {
  const from = here(runtime.owner);
  let trip: Trip | null;
  switch (goal.kind) {
    case 'point':
      trip = tripTo(world, from, { floor: goal.floor, x: goal.at.x, z: goal.at.z });
      break;
    case 'employee': {
      const target = runtime.avatars.get(goal.employeeId);
      if (!target) return null;
      const others = [...runtime.avatars.values()].filter((a) => a !== target && a.floor === target.floor).map((a) => a.pos);
      trip = approachTo(world, from, here(target), { dist: TALK_SPOT, others });
      break;
    }
    default: {
      const unreachable: never = goal;
      return unreachable;
    }
  }
  if (!trip) return null;
  const walk: Walk = { kind: 'walk', trip, goal };
  plannedIn.set(walk, world);
  return walk;
}

// A walk that cannot be planned leaves the owner doing what they were doing, and says why.
export function walkTo(goal: WalkGoal) {
  const door = get().meetingDoor;
  const world = worldFor(get().building, door);
  const walk = world && plan(goal, world);
  if (walk) runtime.owner.intent = walk;
  else toast(door === 'closed' ? 'The meeting room door is closed.' : 'There is no way there.', 'warn');
}

// A walk is planned again when the office has changed under it. A walk to someone also follows them: it is planned
// again when they have moved too far from where it ends, and dropped when they are gone.
function keepUp(walk: Walk, world: World): OwnerIntent {
  const { goal, trip } = walk;
  if (runtime.owner.climb) return walk;
  if (plannedIn.get(walk) !== world || trip.version !== world.version) return plan(goal, world) ?? KEYS_INTENT;
  if (goal.kind !== 'employee') return walk;
  const target = runtime.avatars.get(goal.employeeId);
  if (!target) return KEYS_INTENT;
  const end = tripEnd(trip);
  if (end.floor === target.floor && dist2(end.at, target.pos) <= TALK_REPLAN) return walk;
  return plan(goal, world) ?? KEYS_INTENT;
}

// The velocity the walk asks for this frame, or null when the owner is not walking or has just arrived.
function walkVelocity(world: World): Vec2 | null {
  const { owner } = runtime;
  if (owner.intent.kind === 'walk') owner.intent = keepUp(owner.intent, world);
  const { intent } = owner;
  if (intent.kind !== 'walk') return null;
  const aim = nextAim(owner, intent.trip, ARRIVE);
  if (!aim) {
    owner.intent = KEYS_INTENT;
    return null;
  }
  const left = Math.max(dist2(owner.pos, aim.at), 1e-6);
  // Into the last waypoint the speed falls with the distance left. At 3 m/s per meter the owner stops on it, where a
  // steeper ramp overshoots because the velocity only eases toward what is asked.
  const top = owner.running ? OWNER_RUN : OWNER_WALK;
  const speed = aim.final ? Math.min(top, 3 * left) : top;
  return { x: ((aim.at.x - owner.pos.x) / left) * speed, z: ((aim.at.z - owner.pos.z) / left) * speed };
}

function keyVelocity(): Vec2 {
  const { owner, view, keys } = runtime;
  const down = (...codes: string[]) => codes.some((c) => keys.has(c));
  const fwd = (down('KeyW', 'ArrowUp') ? 1 : 0) - (down('KeyS', 'ArrowDown') ? 1 : 0);
  const str = (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0);

  // Movement is relative to where the camera looks, in every camera mode.
  let dx = Math.sin(view.yaw) * fwd - Math.cos(view.yaw) * str;
  let dz = Math.cos(view.yaw) * fwd + Math.sin(view.yaw) * str;
  const len = Math.hypot(dx, dz);
  const top = len > 0 ? (owner.running ? OWNER_RUN : OWNER_WALK) : 0;
  if (len > 0) {
    dx /= len;
    dz /= len;
  }
  return { x: dx * top, z: dz * top };
}

// A key pressed on the stairs does not drop the owner halfway: they finish the climb first.
function finishClimb(link: StairLink): Vec2 {
  const { pos, floor: _floor } = runtime.owner;
  const left = Math.max(dist2(pos, link.to.at), 1e-6);
  return { x: ((link.to.at.x - pos.x) / left) * OWNER_WALK, z: ((link.to.at.z - pos.z) / left) * OWNER_WALK };
}

// Moves a point on the floor, sliding along whatever is not standable. Returns the distance it actually moved along x and z.
function slide(world: World, floor: number, pos: Vector3, nx: number, nz: number) {
  if (openAt(world, floor, nx, nz)) {
    pos.x = nx;
    pos.z = nz;
  } else if (openAt(world, floor, nx, pos.z)) pos.x = nx;
  else if (openAt(world, floor, pos.x, nz)) pos.z = nz;
}

// The keys carry the owner onto a staircase when they walk into its foot, up from below or down from the landing.
function startKeyClimb(world: World) {
  const { owner } = runtime;
  const speed = Math.hypot(owner.vel.x, owner.vel.z);
  if (owner.intent.kind !== 'keys' || speed < 1) return;
  for (const up of world.links) {
    for (const link of [up, { ...up, from: up.to, to: up.from }]) {
      if (link.from.floor !== owner.floor || dist2(owner.pos, link.from.at) > 0.5) continue;
      const dx = link.to.at.x - link.from.at.x;
      const dz = link.to.at.z - link.from.at.z;
      if ((owner.vel.x * dx + owner.vel.z * dz) / (Math.hypot(dx, dz) * speed) > 0.5) {
        owner.climb = link;
        return;
      }
    }
  }
}

function stepOwner(dt: number, world: World, talkingTo: EmployeeId | null) {
  const { owner, view, keys } = runtime;
  if (!owner.placed) {
    owner.placed = true;
    owner.floor = world.entry.floor;
    // Just inside the door and clear of its frame. The first look east (CameraRig) runs the length of the lobby to the lounge.
    // The ceiling pendants hang on a 4 m grid; standing between two columns keeps the nearest lamp out of the first frame.
    const x = Math.round((world.entry.x + 1.5 - 3.5) / 4) * 4 + 3.5;
    const z = world.entry.z - 2.7;
    owner.pos.set(x, floorBase(owner.floor), z);
    const spot = standable(world, owner.floor, owner.pos);
    if (spot) owner.pos.set(spot.x, owner.pos.y, spot.z);
    owner.yaw = Math.PI;
    runtime.queueYaw = Math.PI;
  }
  owner.running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  // Keys always win. input.ts also drops the walk on the key down itself, because a tap can end between two frames.
  if (!owner.climb && STEER_KEYS.some((c) => keys.has(c))) owner.intent = KEYS_INTENT;

  const want = walkVelocity(world) ?? (owner.climb ? finishClimb(owner.climb) : keyVelocity());
  const a = ease(dt, 12);
  owner.vel.x += (want.x - owner.vel.x) * a;
  owner.vel.z += (want.z - owner.vel.z) * a;
  if (owner.climb) {
    owner.pos.x += owner.vel.x * dt;
    owner.pos.z += owner.vel.z * dt;
    owner.pos.y = climbHeight(owner.climb, owner.pos);
    if (owner.intent.kind !== 'walk' && dist2(owner.pos, owner.climb.to.at) < CLIMB_DONE) {
      owner.floor = owner.climb.to.floor;
      owner.pos.y = floorBase(owner.floor);
      owner.climb = null;
    }
  } else {
    startKeyClimb(world);
    if (!openAt(world, owner.floor, owner.pos.x, owner.pos.z)) {
      const spot = standable(world, owner.floor, owner.pos);
      if (spot) owner.pos.set(spot.x, owner.pos.y, spot.z);
    }
    slide(world, owner.floor, owner.pos, owner.pos.x + owner.vel.x * dt, owner.pos.z + owner.vel.z * dt);
    owner.pos.y = floorBase(owner.floor);
  }
  owner.speed = Math.hypot(owner.vel.x, owner.vel.z);

  // In first person the body faces where the owner looks, so the mouse turns the avatar and a step sideways stays sideways.
  const first = get().camera === 'first';
  if (owner.speed > 0.4) {
    const heading = Math.atan2(owner.vel.x, owner.vel.z);
    owner.yaw += angleDiff(owner.yaw, first ? view.yaw : heading) * ease(dt, 12);
    runtime.queueYaw += angleDiff(runtime.queueYaw, heading) * ease(dt, 2.5);
  } else if (first) {
    owner.yaw = view.yaw;
  } else if (talkingTo) {
    const av = runtime.avatars.get(talkingTo);
    if (av) {
      const target = Math.atan2(av.pos.x - owner.pos.x, av.pos.z - owner.pos.z);
      owner.yaw += angleDiff(owner.yaw, target) * ease(dt, 6);
    }
  }
}

// Where the avatar heads this frame to get to `target`, or null when there is no way there. Its trip is planned again
// when the target has moved or the office has changed since it was made. Once the last waypoint is behind it, it walks
// straight to the target, which can lie a step off the grid beside a desk.
function waypoint(av: AvatarRT, target: FloorPos, world: World): Vec2 | null {
  const stale =
    !av.route ||
    av.route.world !== world ||
    (av.route.trip && av.route.trip.version !== world.version) ||
    av.route.to.floor !== target.floor ||
    dist2(av.route.to, target) > REROUTE;
  if (stale && !av.climb) av.route = { trip: tripTo(world, here(av), target), to: { ...target }, world };
  const trip = av.route?.trip;
  if (!trip) return null;
  const aim = nextAim(av, trip, CORNER);
  if (aim) return aim.at;
  return av.floor === target.floor ? { x: target.x, z: target.z } : null;
}

function stepAvatar(
  av: AvatarRT,
  e: Employee,
  dt: number,
  world: World,
  queueIndex: number,
  talking: boolean,
  meetingDoor: 'open' | 'closed',
) {
  const seat = seatFor(e, world);
  const blocked = e.status.kind === 'blocked_on_owner';
  const ownerPos = runtime.owner.pos;
  const at = (floor: number, p: Vec2): FloorPos => ({ floor, x: p.x, z: p.z });

  let target: FloorPos;
  if (blocked && meetingDoor === 'closed') {
    // Permission cards remain blocked in main, but nobody walks to a closed meeting room.
    av.leaving = false;
    target = at(seat.floor, seat.chair);
  } else if (blocked) {
    if (av.seated) {
      av.seated = false;
      av.leaving = true;
    }
    if (av.leaving && av.floor === seat.floor && dist2(av.pos, seat.exit) < 0.35) av.leaving = false;
    target = av.leaving ? at(seat.floor, seat.exit) : at(runtime.owner.floor, queueSlot(queueIndex));
  } else {
    av.leaving = false;
    target = (av.seated || (av.floor === seat.floor && dist2(av.pos, seat.chair) < 1.4)) ? at(seat.floor, seat.chair) : at(seat.floor, seat.exit);
  }

  // A seated avatar never walks, so a desk that moves (or a floor that changes) takes its sitter along here.
  if (av.seated && (av.floor !== seat.floor || dist2(av.pos, seat.chair) > SEATED_DRIFT)) {
    av.floor = seat.floor;
    av.climb = av.route = null;
    av.pos.set(seat.chair.x, floorBase(seat.floor), seat.chair.z);
  }

  const level = av.floor === target.floor && !av.climb;
  const dist = level ? dist2(av.pos, target) : 1e3;
  let moved = 0;
  const aimAt = !av.seated && dist > 0.03 ? waypoint(av, target, world) : null;
  if (aimAt) {
    const dx = aimAt.x - av.pos.x;
    const dz = aimAt.z - av.pos.z;
    const len = Math.max(Math.hypot(dx, dz), 1e-6);
    // Chasing a moving owner from across the office is tedious, so far-away askers hurry a little.
    const boost = blocked ? 1 + Math.min(0.8, Math.max(0, dist - 6) * 0.08) : 1;
    const step = Math.min(EMPLOYEE_WALK * boost * dt, (level ? dist : 1e3) * 0.35 + 0.002);
    av.pos.x += (dx / len) * step;
    av.pos.z += (dz / len) * step;
    av.pos.y = av.climb ? climbHeight(av.climb, av.pos) : floorBase(av.floor);
    moved = step / dt;
    if (dist > 0.25) av.yaw += angleDiff(av.yaw, Math.atan2(dx, dz)) * ease(dt, 10);
  }
  av.speed += (moved - av.speed) * ease(dt, 10);

  if ((!blocked || meetingDoor === 'closed') && !av.seated && dist <= 0.03) av.seated = true;

  const sameFloor = av.floor === runtime.owner.floor;
  const nearOwner = sameFloor ? Math.hypot(ownerPos.x - av.pos.x, ownerPos.z - av.pos.z) : Infinity;
  const attentive = talking || (blocked && !av.leaving && nearOwner < 3.2);
  if (attentive && (av.seated || dist <= 0.25)) {
    av.yaw += angleDiff(av.yaw, Math.atan2(ownerPos.x - av.pos.x, ownerPos.z - av.pos.z)) * ease(dt, 8);
  } else if (av.seated) {
    av.yaw += angleDiff(av.yaw, seat.yaw) * ease(dt, 6);
  }
}

function nearbyInRange(company: Company): EmployeeId[] {
  if (get().meetingDoor === 'closed' && ownerInsideMeetingRoom()) return [];
  const { pos } = runtime.owner;
  return company.employees
    .map((e) => {
      const av = runtime.avatars.get(e.id);
      return { id: e.id, d: av && av.floor === runtime.owner.floor ? Math.hypot(av.pos.x - pos.x, av.pos.z - pos.z) : Infinity };
    })
    .filter(({ d }) => d <= LISTEN_RADIUS)
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .map(({ id }) => id);
}

function nearestInRange(company: Company, current: EmployeeId | null, nearby = nearbyInRange(company)): EmployeeId | null {
  if (get().meetingDoor === 'closed' && ownerInsideMeetingRoom()) return null;
  const { pos } = runtime.owner;
  let best: EmployeeId | null = nearby[0] ?? null;
  let bestD = Infinity;
  for (const id of nearby) {
    const e = company.employees.find((candidate) => candidate.id === id);
    if (!e) continue;
    const av = runtime.avatars.get(e.id);
    if (!av) continue;
    const d = av.floor === runtime.owner.floor ? Math.hypot(av.pos.x - pos.x, av.pos.z - pos.z) : Infinity;
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  if (current) {
    const av = runtime.avatars.get(current);
    const dCur = av && av.floor === runtime.owner.floor ? Math.hypot(av.pos.x - pos.x, av.pos.z - pos.z) : Infinity;
    // Keep the current employee just outside the radius, but switch immediately when another is closer.
    if (dCur <= LISTEN_EXIT && best === current) return current;
  }
  return bestD <= LISTEN_RADIUS ? best : null;
}

export function stepSim(rawDt: number) {
  const dt = Math.min(rawDt, 0.05);
  runtime.time += dt;
  const { company } = get();
  const meetingDoor = get().meetingDoor;
  const world = worldFor(get().building, meetingDoor);
  if (!world) return;

  if (!company) {
    stepOwner(dt, world, null);
    return;
  }
  syncAvatars(company, world);

  const state = get();
  stepOwner(dt, world, state.talkingTo);

  const queue = waitingQueue(company);
  const queueIndex = new Map(queue.map((e, i) => [e.id, i]));
  for (const e of company.employees) {
    const av = runtime.avatars.get(e.id);
    if (!av) continue;
    const qi = queueIndex.get(e.id) ?? -1;
    stepAvatar(av, e, dt, world, qi, state.talkingTo === e.id, meetingDoor);
  }

  const floors = Object.fromEntries([...runtime.avatars.values()].map((a) => [a.id, a.floor]));
  const moved = Object.keys(floors).length !== Object.keys(state.avatarFloors).length || Object.entries(floors).some(([id, f]) => state.avatarFloors[id] !== f);
  if (moved) set({ avatarFloors: floors });

  const nearbyIds = nearbyInRange(company);
  const desk = ownerSeat(world);
  const chair = desk ? desk.chair : null;
  const nearComputer = !!desk && desk.floor === runtime.owner.floor && !!chair && Math.hypot(runtime.owner.pos.x - chair.x, runtime.owner.pos.z - chair.z) < 1.75;
  const nearProjectComputer =
    company.blocks.find((block) => {
      const stand = terminalStand(world, block.id);
      return !!stand && stand.floor === runtime.owner.floor && dist2(runtime.owner.pos, stand.at) < 1.75;
    })?.id ?? null;
  const nearTaskBoard = taskBoardTarget(company, state.boards, state.tasks, world, runtime.owner.pos, runtime.owner.floor);
  const talkingTo = nearestInRange(company, state.talkingTo, nearbyIds);
  const story = runtime.owner.climb ? Math.min(runtime.owner.climb.from.floor, runtime.owner.climb.to.floor) : runtime.owner.floor;

  // The arrival: the first blocked employee in line has reached the owner.
  if (meetingDoor === 'closed') runtime.arrived.clear();
  const front = meetingDoor === 'open' ? queue[0] : undefined;
  for (const id of [...runtime.arrived.keys()]) {
    if (!queue.some((q) => q.id === id)) runtime.arrived.delete(id);
  }
  if (front && front.status.kind === 'blocked_on_owner') {
    const av = runtime.avatars.get(front.id);
    const qid = front.status.question.id;
    if (av && runtime.arrived.get(front.id) !== qid) {
      const slot = queueSlot(0);
      const near = Math.hypot(av.pos.x - slot.x, av.pos.z - slot.z) < 0.5 || Math.hypot(av.pos.x - runtime.owner.pos.x, av.pos.z - runtime.owner.pos.z) < 1.3;
      if (near && av.floor === runtime.owner.floor && !av.leaving) {
        runtime.arrived.set(front.id, qid);
        const block = company.blocks.find((b) => b.id === front.blockId);
        announceArrival(front, block?.name ?? 'the office');
      }
    }
  }
  const askerId = meetingDoor === 'open' && front && front.status.kind === 'blocked_on_owner' && runtime.arrived.get(front.id) === front.status.question.id ? front.id : null;

  const nearbyChanged = nearbyIds.length !== state.nearbyIds.length || nearbyIds.some((id, i) => id !== state.nearbyIds[i]);
  // While the owner builds, the story on screen is the one they chose, not the one they stand on.
  const shown = get().build ? state.story : story;
  if (shown !== state.story || talkingTo !== state.talkingTo || askerId !== state.askerId || nearbyChanged || nearComputer !== state.nearComputer || nearProjectComputer !== state.nearProjectComputer || nearTaskBoard !== state.nearTaskBoard) {
    if (talkingTo !== state.talkingTo) cancelSpeech();
    set({
      story: shown,
      talkingTo,
      nearbyIds,
      askerId,
      nearComputer,
      nearProjectComputer,
      nearTaskBoard,
      // Proximity opens the side chat and follows the closest person as the owner moves.
      ...(talkingTo && talkingTo !== state.talkingTo ? { selectedId: talkingTo } : {}),
      // Close the drawer when the owner leaves the employee who opened it through proximity chat.
      ...(state.talkingTo && !talkingTo && state.selectedId === state.talkingTo ? { selectedId: null } : {}),
      ...(askerId !== state.askerId ? { cardMinimized: false } : {}),
    });
  }
}
