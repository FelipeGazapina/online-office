// Where a pointer lands on the build plane, and which grid vertex, tile or cell that is.
import { Plane, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { STORY_H, type PickRay, type Vec2 } from '../../../../shared/space/index.ts';

const ray = new Raycaster();
const ndc = new Vector2();
const hit = new Vector3();
const plane = new Plane(new Vector3(0, 1, 0), 0);

export const levelY = (level: number) => level * STORY_H;

/** The point of the floor plane of `level` under a pointer, in meters, or null when the ray misses it. */
export function groundPoint(camera: Camera, el: HTMLElement, clientX: number, clientY: number, level: number): Vec2 | null {
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  plane.constant = -levelY(level);
  const p = ray.ray.intersectPlane(plane, hit);
  return p ? { x: p.x, z: p.z } : null;
}

/** The ray under a pointer, with y measured from the floor of `level`, for the tops of furniture that the floor plane would misplace. */
export function pickRay(camera: Camera, el: HTMLElement, clientX: number, clientY: number, level: number): PickRay {
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const { origin: o, direction: d } = ray.ray;
  return { o: { x: o.x, y: o.y - levelY(level), z: o.z }, d: { x: d.x, y: d.y, z: d.z } };
}

export const vertexOf = (p: Vec2): Vec2 => ({ x: Math.round(p.x), z: Math.round(p.z) });
export const tileOf = (p: Vec2): Vec2 => ({ x: Math.floor(p.x), z: Math.floor(p.z) });
