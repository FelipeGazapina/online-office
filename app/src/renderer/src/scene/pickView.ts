// The camera the office is drawn through, for anything outside the canvas that needs to point into the office, such as a task
// card held over a desk. The camera moves by mutation, so the object registered here stays current.
import { Raycaster, Vector2, type Camera } from 'three';
import type { Ray } from '../deskDrop.ts';

const view: { camera: Camera | null; el: HTMLElement | null } = { camera: null, el: null };
const caster = new Raycaster();
const ndc = new Vector2();

export function setPickView(camera: Camera | null, el: HTMLElement | null) {
  view.camera = camera;
  view.el = el;
}

/** The ray through a viewport pixel, or null before the office is drawn. */
export function rayAt(clientX: number, clientY: number): Ray | null {
  const { camera, el } = view;
  if (!camera || !el) return null;
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  caster.setFromCamera(ndc, camera);
  const { origin: o, direction: d } = caster.ray;
  return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
}
