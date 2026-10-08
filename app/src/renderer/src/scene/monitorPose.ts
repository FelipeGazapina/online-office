// Where each employee's terminal screen stands in the world, and how the camera frames it when the owner zooms in.
// MonitorScreens.tsx fills `monitorPoses` as desks and sitters change. The camera rig and the zoomed terminal panel both
// read `zoomFrame`, so the panel lands exactly on the screen the camera looks at.
import { Vector3 } from 'three';

export type MonitorPose = { center: Vector3; normal: Vector3; w: number; h: number; floor: number };

export const monitorPoses = new Map<string, MonitorPose>();

// For the tests: where each employee's screen stands, and the way it faces.
(window as unknown as { __officeMonitors: unknown }).__officeMonitors = () =>
  Object.fromEntries([...monitorPoses].map(([id, p]) => [id, { center: p.center.toArray(), normal: p.normal.toArray(), w: p.w, h: p.h, floor: p.floor }]));

// The picture's share of the window's height while zoomed.
const FILL = 0.76;
export const ZOOM_FOV = 32;

/** How far from the screen's middle the camera stands, so the screen fills `FILL` of the window and fits across it. */
export function zoomFrame(pose: MonitorPose, aspect: number): { dist: number; fov: number; height: number; width: number } {
  const t = Math.tan((ZOOM_FOV * Math.PI) / 360);
  const dist = Math.max(pose.h / FILL / (2 * t), pose.w / (0.92 * 2 * t * aspect));
  // The panel's size as a share of the window, which the panel turns into pixels.
  const height = pose.h / (2 * dist * t);
  return { dist, fov: ZOOM_FOV, height, width: (pose.w / (2 * dist * t)) / aspect };
}
