import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { runtime } from '../runtime.ts';
import { get, useStore } from '../store.ts';
import { stepSim } from '../sim.ts';

const TOP_DOWN_PITCH = 1.48;
const FOV = 45;
const DRAG_PX = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export function SimDriver() { useFrame((_, dt) => stepSim(dt), -2); return null; }

export function CameraRig() {
  const { gl } = useThree();
  useStore((s) => s.camera);
  const focus = useRef(new Vector3());
  const snap = useRef(true);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; far: boolean } | null>(null);
  const scratch = useRef({ desired: new Vector3(), look: new Vector3() });

  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.x; d.x = e.clientX; d.y = e.clientY;
      d.far ||= Math.hypot(e.clientX - d.ox, e.clientY - d.oy) >= DRAG_PX;
      if (d.far) runtime.view.isoYawTarget -= dx * 0.006;
    };
    const down = (e: PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false }; };
    const up = () => { drag.current = null; };
    const wheel = (e: WheelEvent) => { runtime.view.isoDist = clamp(runtime.view.isoDist + e.deltaY * 0.03, 8, 48); };
    el.addEventListener('pointerdown', down); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); el.addEventListener('wheel', wheel, { passive: true });
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); el.removeEventListener('wheel', wheel); };
  }, [gl]);

  useFrame((state, dt) => {
    const cam = state.camera as PerspectiveCamera;
    const { view, owner, keys } = runtime;
    const { desired, look } = scratch.current;
    const turn = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
    view.isoYawTarget += turn * dt * 1.8;
    view.yaw += (view.isoYawTarget - view.yaw + Math.PI) % (2 * Math.PI) - Math.PI;
    focus.current.lerp(desired.set(owner.pos.x, 0.6, owner.pos.z), ease(dt, snap.current ? 100 : 5));
    const fx = Math.sin(view.yaw), fz = Math.cos(view.yaw), c = Math.cos(TOP_DOWN_PITCH);
    look.copy(focus.current);
    desired.set(look.x - fx * c * view.isoDist, look.y + Math.sin(TOP_DOWN_PITCH) * view.isoDist, look.z - fz * c * view.isoDist);
    if (snap.current) cam.position.copy(desired); else cam.position.lerp(desired, ease(dt, 5));
    snap.current = false; cam.lookAt(look);
    if (Math.abs(cam.fov - FOV) > 0.01) { cam.fov += (FOV - cam.fov) * ease(dt, 6); cam.updateProjectionMatrix(); }
  }, -1);
  return null;
}
