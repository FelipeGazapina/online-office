// Where a pointer lands on the build plane, and which grid vertex, tile or cell that is.
import { Plane, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { STORY_H, type Vec2 } from '../../../../shared/space/index.ts';

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

export const vertexOf = (p: Vec2): Vec2 => ({ x: Math.round(p.x), z: Math.round(p.z) });
export const tileOf = (p: Vec2): Vec2 => ({ x: Math.floor(p.x), z: Math.floor(p.z) });
