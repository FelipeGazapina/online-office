// Per-frame mutable world state. Lives outside React so the sim can write it 60 times a second.
import { Vector3 } from 'three';
import type { EmployeeId } from '../../shared/protocol.ts';
import { OWNER_START, type Vec2 } from './layout.ts';
import type { NavGrid } from './nav.ts';

// The way an avatar is taking to where it is headed. `to` is what the route was planned for and `grid` the office it
// was planned in. A null path means there is no way there.
export type Route = { path: Vec2[] | null; to: Vec2; grid: NavGrid };

export type AvatarRT = {
  id: string;
  pos: Vector3;
  yaw: number;
  speed: number;
  seated: boolean;
  leaving: boolean;
  route: Route | null;
};

export type WalkGoal = { kind: 'point'; at: Vec2 } | { kind: 'employee'; employeeId: EmployeeId };

// What steers the owner. `path` holds the waypoints still to visit, and its last one is where the walk ends.
export type OwnerIntent = { kind: 'keys' } | { kind: 'walk'; path: Vec2[]; goal: WalkGoal };
export const KEYS_INTENT: OwnerIntent = { kind: 'keys' };

// A walk yields to any of these, whether held or only tapped.
export const STEER_KEYS: readonly string[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export const runtime = {
  owner: {
    pos: new Vector3(OWNER_START.x, 0, OWNER_START.z),
    vel: new Vector3(),
    yaw: Math.PI,
    speed: 0,
    running: false,
    // Widened on purpose: the constant alone would type this field as only the keys variant.
    intent: KEYS_INTENT as OwnerIntent,
  },
  // Direction the owner last travelled. The queue trails this, not the body yaw,
  // so turning to look at the first asker does not swing the whole line around.
  queueYaw: Math.PI,
  // yaw is where the camera looks; isoYawTarget is the 90 degree step the overview eases toward.
  // The overview is meant to read as a company map, so leave enough distance for shared rooms and expansion plots.
  view: { yaw: Math.PI, pitch: 0.44, dist: 6.2, isoDist: 62, fpPitch: 0, isoYawTarget: (-3 * Math.PI) / 4 },
  avatars: new Map<string, AvatarRT>(),
  // employee id -> question id already announced (chime, TTS, card)
  arrived: new Map<string, string>(),
  keys: new Set<string>(),
  seeded: false,
  time: 0,
};
