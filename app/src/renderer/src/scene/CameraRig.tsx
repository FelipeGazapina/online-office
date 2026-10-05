import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { angleDiff } from '../layout.ts';
import { runtime } from '../runtime.ts';
import { get, useStore } from '../store.ts';
import { stepSim } from '../sim.ts';

const ISO_PITCH = 0.58;
const FOV = { iso: 26, first: 74 } as const;
const DRAG_PX = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
const uiOpen = (s: ReturnType<typeof get>) => Boolean(s.modal || s.menu || s.helpOpen || s.cardMinimized || s.computerMenu || s.portalMode || s.selectedId);

export function SimDriver() { useFrame((_, dt) => stepSim(dt), -2); return null; }

export function CameraRig() {
  const { gl } = useThree();
  const mode = useStore((s) => s.camera);
  const blocked = useStore(uiOpen);
  const focus = useRef(new Vector3());
  const snap = useRef(true);
  const locked = useRef(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; far: boolean } | null>(null);
  const scratch = useRef({ desired: new Vector3(), look: new Vector3() });

  useEffect(() => {
    const { view } = runtime;
    if (mode === 'iso') {
      if (document.pointerLockElement === gl.domElement) document.exitPointerLock();
      view.isoYawTarget = Math.round((view.yaw + (3 * Math.PI) / 4) / (Math.PI / 2)) * (Math.PI / 2) - (3 * Math.PI) / 4;
    } else view.fpPitch = 0;
  }, [gl, mode]);

  useEffect(() => {
    if (blocked && document.pointerLockElement === gl.domElement) document.exitPointerLock();
  }, [gl, blocked]);

  useEffect(() => {
    const el = gl.domElement;
    const canLock = () => document.hasFocus() && get().camera === 'first' && !uiOpen(get());
    const lock = () => { if (canLock()) void el.requestPointerLock({ unadjustedMovement: true }).catch(() => {}); };
    const toggleLock = () => { if (document.pointerLockElement === el) document.exitPointerLock(); else lock(); };
    const lockChange = () => {
      locked.current = document.pointerLockElement === el;
      el.style.cursor = locked.current ? 'none' : '';
      if (!locked.current) drag.current = null;
    };
    const look = (dx: number, dy: number) => {
      const { view } = runtime;
      view.yaw -= dx * 0.004;
      view.fpPitch = clamp(view.fpPitch - dy * 0.004, -1.25, 1.25);
    };
    const move = (e: PointerEvent) => {
      // Relative deltas keep the view turning after the physical cursor reaches a screen edge.
      if (locked.current) { if (get().camera === 'first') look(e.movementX, e.movementY); return; }
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
      d.far ||= Math.hypot(e.clientX - d.ox, e.clientY - d.oy) >= DRAG_PX;
      if (get().camera === 'first') look(dx, dy);
      else if (d.far) runtime.view.isoYawTarget -= dx * 0.006;
    };
    const down = (e: PointerEvent) => {
      if (locked.current) return;
      drag.current = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false };
      if (canLock()) { e.preventDefault(); e.stopPropagation(); lock(); }
    };
    // While the mouse is captured a click is a look gesture, not a click on whatever sits under the hidden cursor.
    const swallowClick = (e: MouseEvent) => { if (locked.current) { e.preventDefault(); e.stopPropagation(); } };
    const up = () => { drag.current = null; };
    const blur = () => { if (document.pointerLockElement === el) document.exitPointerLock(); };
    const wheel = (e: WheelEvent) => { if (get().camera === 'iso') runtime.view.isoDist = clamp(runtime.view.isoDist + e.deltaY * 0.03, 8, 48); };
    el.addEventListener('pointerdown', down); el.addEventListener('click', swallowClick, true); el.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('blur', blur);
    window.addEventListener('office:toggle-pointer-lock', toggleLock); document.addEventListener('pointerlockchange', lockChange);
    return () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('click', swallowClick, true); el.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('blur', blur);
      window.removeEventListener('office:toggle-pointer-lock', toggleLock); document.removeEventListener('pointerlockchange', lockChange);
      if (document.pointerLockElement === el) document.exitPointerLock();
      locked.current = false; el.style.cursor = '';
    };
  }, [gl]);

  useFrame((state, dt) => {
    const cam = state.camera as PerspectiveCamera;
    const { view, owner, keys } = runtime;
    const { desired, look } = scratch.current;
    const turn = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
    let follow = 5;
    if (mode === 'iso') {
      view.isoYawTarget += turn * dt * 1.8;
      view.yaw += angleDiff(view.yaw, view.isoYawTarget) * ease(dt, 8);
      focus.current.lerp(desired.set(owner.pos.x, 0.6, owner.pos.z), ease(dt, snap.current ? 100 : 5));
      const fx = Math.sin(view.yaw), fz = Math.cos(view.yaw), c = Math.cos(ISO_PITCH);
      look.copy(focus.current);
      desired.set(look.x - fx * c * view.isoDist, look.y + Math.sin(ISO_PITCH) * view.isoDist, look.z - fz * c * view.isoDist);
    } else {
      view.yaw += turn * dt * 1.8;
      // A click walk carries the view with it: toward the person once close, else where the owner is heading.
      const { intent } = owner;
      if (!locked.current && intent.kind === 'walk' && owner.speed > 0.4) {
        const who = intent.goal.kind === 'employee' ? runtime.avatars.get(intent.goal.employeeId) : undefined;
        const close = who && Math.hypot(who.pos.x - owner.pos.x, who.pos.z - owner.pos.z) < 2.5;
        const aim = who && close ? Math.atan2(who.pos.x - owner.pos.x, who.pos.z - owner.pos.z) : Math.atan2(owner.vel.x, owner.vel.z);
        view.yaw += angleDiff(view.yaw, aim) * ease(dt, 4);
      }
      focus.current.set(owner.pos.x, 0.6, owner.pos.z);
      const fx = Math.sin(view.yaw), fz = Math.cos(view.yaw), c = Math.cos(view.fpPitch);
      const bob = Math.sin(runtime.time * 9) * 0.025 * Math.min(1, owner.speed / 3);
      desired.set(owner.pos.x + fx * 0.1, 1.62 + bob, owner.pos.z + fz * 0.1);
      look.set(desired.x + fx * c, desired.y + Math.sin(view.fpPitch), desired.z + fz * c);
      follow = 30;
    }
    if (snap.current) cam.position.copy(desired); else cam.position.lerp(desired, ease(dt, follow));
    snap.current = false; cam.lookAt(look);
    const fov = FOV[mode];
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * ease(dt, 6); cam.updateProjectionMatrix(); }
  }, -1);
  return null;
}
