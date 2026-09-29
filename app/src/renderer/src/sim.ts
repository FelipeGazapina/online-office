// The whole per-frame world loop in one place: owner movement, employee walking, the queue,
// proximity listening and the arrival moment. Avatar targets are derived from the office's
// logical state every frame: blocked_on_owner walks to the owner, everything else goes to the desk.
import { Vector3 } from 'three';
import type { Company, Employee, EmployeeId } from '../../shared/protocol.ts';
import { announceArrival, LISTEN_RADIUS } from './audio.ts';
import {
  angleDiff,
  clampToBounds,
  DOOR,
  deskPose,
  getLayout,
  meetingRoomObstacles,
  OWNER_RADIUS,
  pushOut,
  type DeskPose,
  type Layout,
  type Vec2,
} from './layout.ts';
import { findApproach, findPath, navFor } from './nav.ts';
import { KEYS_INTENT, runtime, STEER_KEYS, type AvatarRT, type OwnerIntent, type WalkGoal } from './runtime.ts';
import { get, set, waitingQueue } from './store.ts';
import { ownerInsideMeetingRoom } from './meeting.ts';

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

export function seatFor(e: Employee, company: Company): DeskPose | null {
  const block = company.blocks.find((b) => b.id === e.blockId);
  return block ? deskPose(block.slot, e.desk) : null;
}

const fallbackSeat: DeskPose = {
  desk: { x: DOOR.x + 4, z: DOOR.z - 3 },
  chair: { x: DOOR.x + 4, z: DOOR.z - 2 },
  exit: { x: DOOR.x + 4, z: DOOR.z - 1 },
};

function syncAvatars(company: Company) {
  const ids = new Set(company.employees.map((e) => e.id as string));
  for (const id of [...runtime.avatars.keys()]) {
    if (ids.has(id)) continue;
    runtime.avatars.delete(id);
    runtime.arrived.delete(id);
  }
  for (const e of company.employees) {
    if (runtime.avatars.has(e.id)) continue;
    // First snapshot: the team is already at work. Later hires walk in through the door.
    const seat = seatFor(e, company) ?? fallbackSeat;
    const seated = !runtime.seeded;
    const start = seated ? seat.chair : { x: DOOR.x, z: DOOR.z - 0.6 };
    runtime.avatars.set(e.id, {
      id: e.id,
      pos: new Vector3(start.x, 0, start.z),
      yaw: Math.PI,
      speed: 0,
      seated,
      leaving: false,
    });
  }
  runtime.seeded = true;
}

type Walk = Extract<OwnerIntent, { kind: 'walk' }>;

function plan(goal: WalkGoal, layout: Layout): Walk | null {
  const grid = navFor(layout);
  const from = runtime.owner.pos;
  switch (goal.kind) {
    case 'point': {
      const path = findPath(grid, from, goal.at);
      return path && { kind: 'walk', path, goal };
    }
    case 'employee': {
      const target = runtime.avatars.get(goal.employeeId);
      if (!target) return null;
      const others = [...runtime.avatars.values()].filter((a) => a !== target).map((a) => a.pos);
      const path = findApproach(grid, from, target.pos, { dist: TALK_SPOT, others });
      return path && { kind: 'walk', path, goal };
    }
    default: {
      const unreachable: never = goal;
      return unreachable;
    }
  }
}

// A walk that cannot be planned leaves the owner doing what they were doing.
export function walkTo(goal: WalkGoal) {
  const walk = plan(goal, getLayout(get().company?.blocks ?? []));
  if (walk) runtime.owner.intent = walk;
}

// A walk to someone follows them: it is planned again when they have moved too far from where it ends, and dropped
// when they are gone.
function keepUp(walk: Walk, layout: Layout): OwnerIntent {
  const { goal, path } = walk;
  if (goal.kind !== 'employee') return walk;
  const target = runtime.avatars.get(goal.employeeId);
  if (!target) return KEYS_INTENT;
  if (dist2(path[path.length - 1], target.pos) <= TALK_REPLAN) return walk;
  return plan(goal, layout) ?? KEYS_INTENT;
}

// The velocity the walk asks for this frame, or null when the owner is not walking or has just arrived.
function walkVelocity(layout: Layout): Vec2 | null {
  const { owner } = runtime;
  if (owner.intent.kind === 'walk') owner.intent = keepUp(owner.intent, layout);
  const { intent } = owner;
  if (intent.kind !== 'walk') return null;
  const { path } = intent;
  while (path.length > 1 && dist2(owner.pos, path[0]) < CORNER) path.shift();
  const next = path[0];
  const left = dist2(owner.pos, next);
  const last = path.length === 1;
  if (last && left < ARRIVE) {
    owner.intent = KEYS_INTENT;
    return null;
  }
  // Into the last waypoint the speed falls with the distance left. At 3 m/s per meter the owner stops on it, where a
  // steeper ramp overshoots because the velocity only eases toward what is asked.
  const top = owner.running ? OWNER_RUN : OWNER_WALK;
  const speed = last ? Math.min(top, 3 * left) : top;
  return { x: ((next.x - owner.pos.x) / left) * speed, z: ((next.z - owner.pos.z) / left) * speed };
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

function stepOwner(dt: number, layout: Layout, talkingTo: EmployeeId | null) {
  const { owner, view, keys } = runtime;
  owner.running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  // Keys always win. input.ts also drops the walk on the key down itself, because a tap can end between two frames.
  if (STEER_KEYS.some((c) => keys.has(c))) owner.intent = KEYS_INTENT;

  const want = walkVelocity(layout) ?? keyVelocity();
  const a = ease(dt, 12);
  owner.vel.x += (want.x - owner.vel.x) * a;
  owner.vel.z += (want.z - owner.vel.z) * a;
  owner.pos.x += owner.vel.x * dt;
  owner.pos.z += owner.vel.z * dt;
  pushOut(owner.pos, OWNER_RADIUS, layout.obstacles);
  clampToBounds(owner.pos, layout.bounds);
  owner.speed = Math.hypot(owner.vel.x, owner.vel.z);

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

function stepAvatar(
  av: AvatarRT,
  e: Employee,
  dt: number,
  company: Company,
  layout: Layout,
  queueIndex: number,
  talking: boolean,
  meetingDoor: 'open' | 'closed',
) {
  const seat = seatFor(e, company) ?? fallbackSeat;
  const blocked = e.status.kind === 'blocked_on_owner';
  const ownerPos = runtime.owner.pos;

  let target: Vec2;
  if (blocked && meetingDoor === 'closed') {
    // Permission cards remain blocked in main, but nobody walks to a closed meeting room.
    av.leaving = false;
    target = seat.chair;
  } else if (blocked) {
    if (av.seated) {
      av.seated = false;
      av.leaving = true;
    }
    if (av.leaving && dist2(av.pos, seat.exit) < 0.35) av.leaving = false;
    target = av.leaving ? seat.exit : queueSlot(queueIndex);
  } else {
    av.leaving = false;
    target = av.seated || dist2(av.pos, seat.chair) < 1.4 ? seat.chair : seat.exit;
  }

  const dx = target.x - av.pos.x;
  const dz = target.z - av.pos.z;
  const dist = Math.hypot(dx, dz);
  let moved = 0;
  if (!av.seated && dist > 0.03) {
    // Chasing a moving owner from across the office is tedious, so far-away askers hurry a little.
    const boost = blocked ? 1 + Math.min(0.8, Math.max(0, dist - 6) * 0.08) : 1;
    const step = Math.min(EMPLOYEE_WALK * boost * dt, dist * 0.35 + 0.002);
    av.pos.x += (dx / dist) * step;
    av.pos.z += (dz / dist) * step;
    pushOut(av.pos, 0.3, layout.obstacles);
    clampToBounds(av.pos, layout.bounds, 0.4);
    moved = step / dt;
    if (dist > 0.25) av.yaw += angleDiff(av.yaw, Math.atan2(dx, dz)) * ease(dt, 10);
  }
  av.speed += (moved - av.speed) * ease(dt, 10);

  if ((!blocked || meetingDoor === 'closed') && !av.seated && dist <= 0.03) av.seated = true;

  const nearOwner = Math.hypot(ownerPos.x - av.pos.x, ownerPos.z - av.pos.z);
  const attentive = talking || (blocked && !av.leaving && nearOwner < 3.2);
  if (attentive && (av.seated || dist <= 0.25)) {
    av.yaw += angleDiff(av.yaw, Math.atan2(ownerPos.x - av.pos.x, ownerPos.z - av.pos.z)) * ease(dt, 8);
  } else if (av.seated) {
    av.yaw += angleDiff(av.yaw, Math.PI) * ease(dt, 6);
  }
}

function nearestInRange(company: Company, current: EmployeeId | null): EmployeeId | null {
  if (get().meetingDoor === 'closed' && ownerInsideMeetingRoom()) return null;
  const { pos } = runtime.owner;
  let best: EmployeeId | null = null;
  let bestD = Infinity;
  for (const e of company.employees) {
    const av = runtime.avatars.get(e.id);
    if (!av) continue;
    const d = Math.hypot(av.pos.x - pos.x, av.pos.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  if (current) {
    const av = runtime.avatars.get(current);
    const dCur = av ? Math.hypot(av.pos.x - pos.x, av.pos.z - pos.z) : Infinity;
    // Hysteresis so standing on the edge of the radius does not flicker the listener on and off.
    if (dCur <= LISTEN_EXIT && (best === current || dCur <= bestD + 0.25)) return current;
  }
  return bestD <= LISTEN_RADIUS ? best : null;
}

export function stepSim(rawDt: number) {
  const dt = Math.min(rawDt, 0.05);
  runtime.time += dt;
  const { company } = get();
  const layout = getLayout(company?.blocks ?? []);

  if (!company) {
    stepOwner(dt, layout, null);
    return;
  }
  syncAvatars(company);

  const state = get();
  const meetingDoor = state.meetingDoor;
  const collision = meetingDoor === 'closed' ? [...layout.obstacles, ...meetingRoomObstacles(true)] : [...layout.obstacles, ...meetingRoomObstacles(false)];
  const collisionLayout = { ...layout, obstacles: collision };
  stepOwner(dt, collisionLayout, state.talkingTo);

  const queue = waitingQueue(company);
  for (const e of company.employees) {
    const av = runtime.avatars.get(e.id);
    if (!av) continue;
    const qi = queue.findIndex((q) => q.id === e.id);
    stepAvatar(av, e, dt, company, collisionLayout, qi, state.talkingTo === e.id, meetingDoor);
  }

  const talkingTo = nearestInRange(company, state.talkingTo);

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
      if (near && !av.leaving) {
        runtime.arrived.set(front.id, qid);
        const block = company.blocks.find((b) => b.id === front.blockId);
        announceArrival(front, block?.name ?? 'the office');
      }
    }
  }
  const askerId = meetingDoor === 'open' && front && front.status.kind === 'blocked_on_owner' && runtime.arrived.get(front.id) === front.status.question.id ? front.id : null;

  if (talkingTo !== state.talkingTo || askerId !== state.askerId) {
    set({ talkingTo, askerId, ...(askerId !== state.askerId ? { cardMinimized: false } : {}) });
  }
}
