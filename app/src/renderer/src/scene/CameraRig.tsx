import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { angleDiff } from '../layout.ts';
import { runtime } from '../runtime.ts';
import { get, useStore } from '../store.ts';
import { stepSim } from '../sim.ts';

const ISO_PITCH = 0.78;
const FOV = { follow: 55, iso: 26, first: 74 } as const;
// The distance the scene uses to tell a click from a drag.
const DRAG_PX = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

// Runs the sim first (priority -2), then places the camera from the fresh owner position (-1).
export function SimDriver() {
  useFrame((_, dt) => stepSim(dt), -2);
  return null;
}

export function CameraRig() {
  const { gl } = useThree();
  const mode = useStore((s) => s.camera);
  const focus = useRef(new Vector3());
  const snap = useRef(true);
  const scratch = useRef({ desired: new Vector3(), look: new Vector3() });

  useEffect(() => {
    const { view, owner } = runtime;
    if (mode === 'iso' && document.pointerLockElement === gl.domElement) document.exitPointerLock();
    if (mode === 'follow') view.yaw = owner.yaw;
    if (mode === 'iso') view.isoYawTarget = Math.round((view.yaw + (3 * Math.PI) / 4) / (Math.PI / 2)) * (Math.PI / 2) - (3 * Math.PI) / 4;
    if (mode === 'first') view.fpPitch = 0;
  }, [gl, mode]);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number; ox: number; oy: number; far: boolean } | null = null;
    let overScene = false;
    let locked = false;
    const enter = () => { overScene = true; };
    const leave = () => { overScene = false; };
    const lock = () => {
      if (!document.hasFocus() || get().camera === 'iso' || document.pointerLockElement === el) return;
      void el.requestPointerLock({ unadjustedMovement: true }).catch(() => {
        // Pointer lock can be refused until the Electron window has focus.
      });
    };
    const lockChange = () => {
      locked = document.pointerLockElement === el;
      el.style.cursor = locked ? 'none' : '';
      if (!locked) drag = null;
    };
    const refocus = () => { if (overScene) lock(); };
    const toggleLock = () => {
      if (document.pointerLockElement === el) document.exitPointerLock();
      else lock();
    };
    const down = (e: PointerEvent) => {
      if (locked) return;
      drag = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false };
    };
    const move = (e: PointerEvent) => {
      const { view } = runtime;
      const m = get().camera;
      // Follow and first-person look continuously while the office is focused;
      // they do not require the owner to hold the mouse button. movementX/Y
      // are relative deltas, so looking keeps working after the cursor reaches
      // a screen edge. Drag state remains for click detection and overview.
      if (!drag && overScene && document.hasFocus() && (m === 'follow' || m === 'first')) {
        const dx = e.movementX;
        const dy = e.movementY;
        if (m === 'follow') {
          view.yaw -= dx * 0.006;
          view.pitch = clamp(view.pitch + dy * 0.004, 0.08, 1.3);
        } else {
          view.yaw -= dx * 0.004;
          view.fpPitch = clamp(view.fpPitch - dy * 0.004, -1.25, 1.25);
        }
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.far ||= Math.hypot(e.clientX - drag.ox, e.clientY - drag.oy) >= DRAG_PX;
      if (m === 'follow') {
        view.yaw -= dx * 0.006;
        view.pitch = clamp(view.pitch + dy * 0.004, 0.08, 1.3);
      } else if (m === 'first') {
        view.yaw -= dx * 0.004;
        view.fpPitch = clamp(view.fpPitch - dy * 0.004, -1.25, 1.25);
      } else if (drag.far) {
        // A click that wobbles a few pixels must not nudge the overview off its axes, so only a real drag turns it.
        view.isoYawTarget -= dx * 0.006;
      }
    };
    const up = () => {
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      const { view } = runtime;
      const m = get().camera;
      if (m === 'follow') view.dist = clamp(view.dist + e.deltaY * 0.004, 2.5, 10);
      if (m === 'iso') view.isoDist = clamp(view.isoDist + e.deltaY * 0.03, 18, 72);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerenter', lock);
    el.addEventListener('pointerleave', leave);
    document.addEventListener('pointerlockchange', lockChange);
    window.addEventListener('focus', refocus);
    window.addEventListener('office:toggle-pointer-lock', toggleLock);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerenter', lock);
      el.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerlockchange', lockChange);
      window.removeEventListener('focus', refocus);
      window.removeEventListener('office:toggle-pointer-lock', toggleLock);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      if (document.pointerLockElement === el) document.exitPointerLock();
      el.style.cursor = '';
    };
  }, [gl]);

  useFrame((state, dt) => {
    const cam = state.camera as PerspectiveCamera;
    const { view, owner, keys } = runtime;
    const { desired, look } = scratch.current;
    const turn = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);

    if (mode === 'iso') view.yaw += angleDiff(view.yaw, view.isoYawTarget) * ease(dt, 6);
    else view.yaw += turn * dt * 1.8;

    // A click walk carries the first person view with it: toward the person once close, else where the owner is heading.
    const { intent } = owner;
    if (mode === 'first' && intent.kind === 'walk' && owner.speed > 0.4) {
      const who = intent.goal.kind === 'employee' ? runtime.avatars.get(intent.goal.employeeId) : undefined;
      const close = who && Math.hypot(who.pos.x - owner.pos.x, who.pos.z - owner.pos.z) < 2.5;
      const aim = who && close ? Math.atan2(who.pos.x - owner.pos.x, who.pos.z - owner.pos.z) : Math.atan2(owner.vel.x, owner.vel.z);
      view.yaw += angleDiff(view.yaw, aim) * ease(dt, 4);
    }

    const fx = Math.sin(view.yaw);
    const fz = Math.cos(view.yaw);
    let follow = 8;
    if (mode !== 'iso') focus.current.set(owner.pos.x, 0.6, owner.pos.z);

    if (mode === 'follow') {
      look.set(owner.pos.x, 1.35, owner.pos.z);
      const c = Math.cos(view.pitch);
      desired.set(look.x - fx * c * view.dist, look.y + Math.sin(view.pitch) * view.dist, look.z - fz * c * view.dist);
      look.x += fx * 1.6;
      look.z += fz * 1.6;
    } else if (mode === 'iso') {
      focus.current.lerp(desired.set(owner.pos.x, 0.6, owner.pos.z), ease(dt, snap.current ? 100 : 1.5));
      const c = Math.cos(ISO_PITCH);
      look.copy(focus.current);
      desired.set(look.x - fx * c * view.isoDist, look.y + Math.sin(ISO_PITCH) * view.isoDist, look.z - fz * c * view.isoDist);
      follow = 5;
    } else {
      const bob = Math.sin(runtime.time * 9) * 0.025 * Math.min(1, owner.speed / 3);
      desired.set(owner.pos.x + fx * 0.1, 1.62 + bob, owner.pos.z + fz * 0.1);
      const c = Math.cos(view.fpPitch);
      look.set(desired.x + fx * c, desired.y + Math.sin(view.fpPitch), desired.z + fz * c);
      follow = 30;
    }

    if (snap.current) cam.position.copy(desired);
    else cam.position.lerp(desired, ease(dt, follow));
    snap.current = false;
    cam.lookAt(look);

    const fov = FOV[mode];
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * ease(dt, 6);
      cam.updateProjectionMatrix();
    }
  }, -1);

  return null;
}
