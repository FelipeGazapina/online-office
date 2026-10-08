// Per-frame mutable world state. Lives outside React so the sim can write it 60 times a second.
import { Vector3 } from 'three';
import type { EmployeeId } from '../../shared/protocol.ts';
import type { FloorPos, StairLink, Trip, Vec2, World } from './world.ts';

// The way an avatar is taking to where it is headed. `to` is what the trip was planned for and `world` the office it
// was planned in. A null trip means there is no way there.
export type Route = { trip: Trip | null; to: FloorPos; world: World };

export type AvatarRT = {
  id: string;
  pos: Vector3;
  floor: number;
  // The staircase being climbed, or null on level ground.
  climb: StairLink | null;
  yaw: number;
  speed: number;
  seated: boolean;
  leaving: boolean;
  route: Route | null;
};

export type WalkGoal = { kind: 'point'; at: Vec2; floor: number } | { kind: 'employee'; employeeId: EmployeeId };

// What steers the owner. `trip` holds the legs still to walk, floor by floor, and the last waypoint of the last leg is where the walk ends.
export type OwnerIntent = { kind: 'keys' } | { kind: 'walk'; trip: Trip; goal: WalkGoal };
export const KEYS_INTENT: OwnerIntent = { kind: 'keys' };

// A walk yields to any of these, whether held or only tapped.
export const STEER_KEYS: readonly string[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export const runtime = {
  owner: {
    pos: new Vector3(0, 0, 0),
    floor: 0,
    climb: null as StairLink | null,
    // False until the sim has put the owner at the front door of the building it was given.
    placed: false,
    vel: new Vector3(),
    yaw: Math.PI,
    speed: 0,
    running: false,
    // Widened on purpose: the constant alone would type this field as only the keys variant.
    intent: KEYS_INTENT as OwnerIntent,
    // The employee the owner chose to walk to. Their chat opens when the owner reaches them, unless a key or another
    // walk replaces the choice first.
    approach: null as EmployeeId | null,
  },
  // Direction the owner last travelled. The queue trails this, not the body yaw,
  // so turning to look at the first asker does not swing the whole line around.
  queueYaw: Math.PI,
  // blend is how far the camera has travelled from the overview (0) to the owner's eyes (1).
  // yaw is where the camera looks; isoYawTarget is the 90 degree step the overview eases toward.
  // The overview is meant to read as a company map, so leave enough distance for shared rooms and expansion plots.
  view: { yaw: Math.PI, pitch: 0.44, dist: 6.2, isoDist: 62, fpPitch: 0, blend: 0, isoYawTarget: (-3 * Math.PI) / 4 },
  avatars: new Map<string, AvatarRT>(),
  // employee id -> question id already announced (chime, TTS, card)
  arrived: new Map<string, string>(),
  keys: new Set<string>(),
  seeded: false,
  time: 0,
};
