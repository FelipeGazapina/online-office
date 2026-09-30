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
  const uiOpen = useStore((s) => Boolean(s.modal || s.menu || s.helpOpen || s.cardMinimized || s.computerMenu || s.portalMode || s.selectedId));
  const focus = useRef(new Vector3());
  const focusTarget = useRef(new Vector3());
  const snap = useRef(true);
  const pointerLocked = useRef(false);
  const scratch = useRef({ desired: new Vector3(), look: new Vector3() });

  useEffect(() => {
    const { view, owner } = runtime;
    snap.current = true;
    if (mode !== 'first' && document.pointerLockElement === gl.domElement) document.exitPointerLock();
    if (mode === 'follow') view.yaw = owner.yaw;
    if (mode === 'iso') view.isoYawTarget = Math.round((view.yaw + (3 * Math.PI) / 4) / (Math.PI / 2)) * (Math.PI / 2) - (3 * Math.PI) / 4;
    if (mode === 'first') view.fpPitch = 0;
  }, [gl, mode]);

  useEffect(() => {
    if (uiOpen && document.pointerLockElement === gl.domElement) document.exitPointerLock();
  }, [gl, uiOpen]);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number; ox: number; oy: number; far: boolean } | null = null;
    type PointerState = 'free' | 'locked';
    let pointer: PointerState = document.pointerLockElement === el ? 'locked' : 'free';
    pointerLocked.current = pointer === 'locked';
    const toggleLock = () => {
      if (document.pointerLockElement === el) {
        document.exitPointerLock();
        return;
      }
      const s = get();
      if (!document.hasFocus() || s.camera !== 'first' || s.modal || s.menu || s.helpOpen || s.cardMinimized || s.computerMenu || s.portalMode || s.selectedId) return;
      void el.requestPointerLock({ unadjustedMovement: true }).catch(() => {});
    };
    const lockChange = () => {
      pointer = document.pointerLockElement === el ? 'locked' : 'free';
      pointerLocked.current = pointer === 'locked';
      el.style.cursor = pointer === 'locked' ? 'none' : '';
      if (pointer === 'free') drag = null;
    };
    const down = (e: PointerEvent) => {
      if (pointer === 'locked') return;
      const s = get();
      if (s.camera === 'first' && !s.modal && !s.menu && !s.helpOpen && !s.cardMinimized && !s.computerMenu && !s.portalMode && !s.selectedId) {
        drag = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false };
        e.preventDefault();
        e.stopPropagation();
        void el.requestPointerLock({ unadjustedMovement: true }).catch(() => {});
        return;
      }
      drag = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false };
    };
    const blockSceneClick = (e: MouseEvent) => {
      if (pointer === 'locked') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const blur = () => {
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
    const move = (e: PointerEvent) => {
      const { view } = runtime;
      const m = get().camera;
      // Relative deltas keep the FPS view turning after the physical cursor reaches a screen edge.
      if (pointer === 'locked' && document.hasFocus() && m === 'first') {
        const dx = e.movementX;
        const dy = e.movementY;
        view.yaw -= dx * 0.004;
        view.fpPitch = clamp(view.fpPitch - dy * 0.004, -1.25, 1.25);
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
    el.addEventListener('click', blockSceneClick, true);
    document.addEventListener('pointerlockchange', lockChange);
    window.addEventListener('office:toggle-pointer-lock', toggleLock);
    window.addEventListener('blur', blur);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('click', blockSceneClick, true);
      document.removeEventListener('pointerlockchange', lockChange);
      window.removeEventListener('office:toggle-pointer-lock', toggleLock);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      if (document.pointerLockElement === el) document.exitPointerLock();
      pointerLocked.current = false;
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
    if (mode === 'first' && !pointerLocked.current && intent.kind === 'walk' && owner.speed > 0.4) {
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
      focusTarget.current.set(owner.pos.x, 0.6, owner.pos.z);
      if (snap.current) focus.current.copy(focusTarget.current);
      else focus.current.lerp(focusTarget.current, ease(dt, 6));
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
