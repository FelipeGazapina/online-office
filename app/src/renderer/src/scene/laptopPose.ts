// The laptop the owner carries: where it is in the owner's hands at each moment of taking it out, where its screen faces, and
// how the camera frames it. OwnerLaptop.tsx draws it from these numbers, Person.tsx puts the hands on it, CameraRig.tsx flies to
// it and LaptopPanel.tsx lays the desktop on its screen, so all four agree to the millimetre.
//
// Everything is in metres in the owner's own frame: x across the body, y up from the floor, z forward. The laptop's own frame has
// its origin on the hinge, at the top of the base: the base runs back toward the owner (-z) and the lid swings up from the hinge.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { MonitorPose } from './monitorPose.ts';

export const LAPTOP = { w: 0.33, d: 0.23, base: 0.016, lid: 0.215, shell: 0.008 } as const;
export const SCREEN = { w: 0.3, h: 0.19, y: 0.113, out: 0.0012 } as const;

// Seconds for each step of taking it out: the hands bring it up, the lid opens, the camera goes into the screen. Putting it
// away plays the same steps backward, faster.
export const LIFT = 0.45;
export const LID = 0.45;
export const ZOOM = 0.6;
export const TOTAL = LIFT + LID + ZOOM;
export const AWAY_SPEED = 1.6;

// The picture's share of the window's height once zoomed. A little more than a monitor's, so the desktop has room.
export const LAPTOP_FILL = 0.82;

// Held: the hinge in front of the chest, the base tipped up at the far edge, the screen leaned back so it faces the eyes.
const HOLD = new Vector3(0, 1.15, 0.5);
const TIP = -0.1;
const LEAN = 0.62;
// Where it comes from: low in front of the thighs, tipped down, turned a little and smaller, as it comes out of the inventory.
const FROM = new Vector3(0.04, 0.82, 0.38);
const FROM_TIP = -0.6;
const FROM_SPIN = 0.4;
const FROM_SCALE = 0.7;
// The lid shut on the keys, and open: the screen leans back by LEAN from upright, whatever the base's tip.
const SHUT = -Math.PI / 2;
const OPEN = LEAN - TIP;
// Where each hand holds it: under the base, toward the owner, in the laptop's own frame.
const GRIP = { x: 0.15, y: -0.045, z: -0.1 };

// The over-the-shoulder shot the camera takes while the owner brings the laptop up and opens it. It stays close, so it is in the
// owner's own space wherever they stand; a wall behind them is not drawn from its far side anyway.
const SHOW = new Vector3(-0.72, 1.95, -0.36);
export const SHOW_FOV = 48;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const step = (s: number, from: number, length: number) => smooth(clamp01((s - from) / length));

/** How far each step has gone at `s` seconds into taking it out, 0 to 1. `show` is the camera's way to the shoulder. */
export function phases(s: number) {
  return {
    lift: step(s, 0, LIFT),
    // The arms rise a little ahead of the laptop, so the hands meet it rather than trail it.
    arms: step(s, 0, LIFT * 0.7),
    lid: step(s, LIFT * 0.8, LID),
    show: step(s, 0, LIFT + LID * 0.6),
    zoom: step(s, LIFT + LID, ZOOM),
  };
}

export type LaptopLocal = { at: Vector3; tip: number; spin: number; scale: number; lid: number };

/** The laptop in the owner's frame at `s` seconds: where its hinge is, how it is tipped and turned, its size and the lid's angle. */
export function laptopLocal(s: number, out: LaptopLocal = { at: new Vector3(), tip: 0, spin: 0, scale: 1, lid: SHUT }): LaptopLocal {
  const { lift, lid } = phases(s);
  out.at.lerpVectors(FROM, HOLD, lift);
  out.tip = FROM_TIP + (TIP - FROM_TIP) * lift;
  out.spin = FROM_SPIN * (1 - lift);
  out.scale = FROM_SCALE + (1 - FROM_SCALE) * lift;
  out.lid = SHUT + (OPEN - SHUT) * lid;
  return out;
}

const scratch = { m: new Matrix4(), lid: new Matrix4(), q: new Quaternion(), e: new Euler(), v: new Vector3(), local: laptopLocal(0) };

/** The laptop's own frame in the owner's frame, composed the way three.js composes an Object3D's position, rotation and scale. */
export function laptopMatrix(l: LaptopLocal, out: Matrix4): Matrix4 {
  return out.compose(l.at, scratch.q.setFromEuler(scratch.e.set(l.tip, l.spin, 0)), scratch.v.setScalar(l.scale));
}

/** Where each hand goes at `s` seconds, in the owner's frame: on the laptop, wherever it is on its way up. */
export function laptopHands(s: number, left: Vector3, right: Vector3) {
  const m = laptopMatrix(laptopLocal(s, scratch.local), scratch.m);
  left.set(-GRIP.x, GRIP.y, GRIP.z).applyMatrix4(m);
  right.set(GRIP.x, GRIP.y, GRIP.z).applyMatrix4(m);
}

/** The owner's frame in the world: standing at `pos`, facing `yaw` the way Person turns them. */
export function ownerMatrix(pos: Vector3, yaw: number, out: Matrix4): Matrix4 {
  return out.compose(pos, scratch.q.setFromEuler(scratch.e.set(0, yaw, 0)), scratch.v.setScalar(1));
}

/** The lid's frame in the world at `s` seconds: the hinge, turned as far as the lid is open. The screen lies on it at y = SCREEN.y. */
export function lidMatrix(owner: Matrix4, s: number, out: Matrix4): Matrix4 {
  const l = laptopLocal(s, scratch.local);
  out.multiplyMatrices(owner, laptopMatrix(l, scratch.lid));
  return out.multiply(scratch.lid.makeRotationX(l.lid));
}

/** The laptop's screen in the world at `s` seconds: its middle, the way it faces (toward the owner) and its size. */
export function laptopScreen(owner: Matrix4, s: number, out: MonitorPose): MonitorPose {
  const m = lidMatrix(owner, s, scratch.m);
  out.center.set(0, SCREEN.y, -SCREEN.out).applyMatrix4(m);
  out.normal.set(0, 0, -1).transformDirection(m);
  out.w = SCREEN.w * scratch.local.scale;
  out.h = SCREEN.h * scratch.local.scale;
  return out;
}

/** Where the camera stands for the over-the-shoulder shot, in the world. */
export function showPoint(owner: Matrix4, out: Vector3): Vector3 {
  return out.copy(SHOW).applyMatrix4(owner);
}
