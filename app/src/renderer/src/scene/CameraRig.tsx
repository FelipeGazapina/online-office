import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { angleDiff } from '../util.ts';
import { runtime } from '../runtime.ts';
import { get, useStore } from '../store.ts';
import { stepSim } from '../sim.ts';
import { crowd } from './people/crowd.ts';

const ISO_PITCH = 0.58;
const FOV_ISO = 26;
const FOV_FIRST = 70;
const EYE = 1.6;
// Seconds the camera takes to fly between the overview and the owner's eyes.
const FLIGHT = 0.8;
const LOOK_SPEED = 0.0024;
const DRAG_PX = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
const probe = new Vector3();
const smooth = (t: number) => t * t * (3 - 2 * t);

export function SimDriver() { useFrame((_, dt) => stepSim(dt), -2); return null; }

// Anything on screen that wants the cursor: the mouse must be free for it.
const uiOpen = () => {
  const s = get();
  return Boolean(s.modal || s.menu || s.helpOpen || s.computerMenu || s.portalMode || s.selectedId);
};

export function CameraRig() {
  const { gl } = useThree();
  const mode = useStore((s) => s.camera);
  const ui = useStore(() => uiOpen());
  const focus = useRef(new Vector3());
  const snap = useRef(true);
  const placed = useRef(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; far: boolean } | null>(null);
  const locked = useRef(false);
  const scratch = useRef({ iso: new Vector3(), isoPos: new Vector3(), isoLook: new Vector3(), eye: new Vector3(), eyeLook: new Vector3(), look: new Vector3(), want: new Vector3() });

  useEffect(() => {
    const { view } = runtime;
    if (mode === 'iso') {
      if (document.pointerLockElement === gl.domElement) document.exitPointerLock();
      // Land the overview on a 90 degree step, the way Q and E do, so it never rests crooked.
      view.isoYawTarget = Math.round((view.yaw + (3 * Math.PI) / 4) / (Math.PI / 2)) * (Math.PI / 2) - (3 * Math.PI) / 4;
    } else {
      view.fpPitch = 0;
      view.isoYawTarget = view.yaw;
    }
  }, [gl, mode]);

  useEffect(() => {
    if (ui && document.pointerLockElement === gl.domElement) document.exitPointerLock();
  }, [gl, ui]);

  useEffect(() => {
    const el = gl.domElement;
    const lock = () => {
      if (document.pointerLockElement === el || get().camera !== 'first' || uiOpen() || !document.hasFocus()) return;
      void el.requestPointerLock().catch(() => {});
    };
    const toggleLock = () => (document.pointerLockElement === el ? document.exitPointerLock() : lock());
    const lockChange = () => {
      locked.current = document.pointerLockElement === el;
      el.style.cursor = locked.current ? 'none' : '';
      if (locked.current) drag.current = null;
    };
    const down = (e: PointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, far: false };
      if (get().camera === 'first') lock();
    };
    // A locked cursor sits still, so a click would hit whatever was under it when the lock began.
    const blockClick = (e: MouseEvent) => {
      if (locked.current) { e.preventDefault(); e.stopPropagation(); }
    };
    const move = (e: PointerEvent) => {
      const { view } = runtime;
      if (get().camera === 'first') {
        // Relative deltas keep the view turning after the cursor would have hit a screen edge.
        // Without a lock (an unfocused window, a refused request) a drag turns the view instead.
        let dx = e.movementX, dy = e.movementY;
        if (!locked.current) {
          const d = drag.current; if (!d) return;
          dx = e.clientX - d.x; dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
        }
        view.yaw -= dx * LOOK_SPEED;
        view.fpPitch = clamp(view.fpPitch - dy * LOOK_SPEED, -1.25, 1.25);
        return;
      }
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.x; d.x = e.clientX; d.y = e.clientY;
      d.far ||= Math.hypot(e.clientX - d.ox, e.clientY - d.oy) >= DRAG_PX;
      if (d.far) view.isoYawTarget -= dx * 0.006;
    };
    const up = () => { drag.current = null; };
    const wheel = (e: WheelEvent) => { if (get().camera === 'iso') runtime.view.isoDist = clamp(runtime.view.isoDist + e.deltaY * 0.03, 8, 48); };
    const blur = () => { if (document.pointerLockElement === el) document.exitPointerLock(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('click', blockClick, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('office:lock-pointer', lock);
    window.addEventListener('office:toggle-pointer-lock', toggleLock);
    document.addEventListener('pointerlockchange', lockChange);
    el.addEventListener('wheel', wheel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('click', blockClick, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('office:lock-pointer', lock);
      window.removeEventListener('office:toggle-pointer-lock', toggleLock);
      document.removeEventListener('pointerlockchange', lockChange);
      el.removeEventListener('wheel', wheel);
      if (document.pointerLockElement === el) document.exitPointerLock();
      el.style.cursor = '';
      locked.current = false;
    };
  }, [gl]);

  useFrame((state, dt) => {
    const cam = state.camera as PerspectiveCamera;
    const { view, owner, keys } = runtime;
    const { iso, isoPos, isoLook, eye, eyeLook, look, want } = scratch.current;
    const first = get().camera === 'first';
    const turn = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);

    // Q and E turn the overview; in first person they turn the head (the mouse does too).
    if (first) view.yaw += turn * dt * 1.8;
    else view.isoYawTarget += turn * dt * 1.8;
    if (!first) view.yaw += angleDiff(view.yaw, view.isoYawTarget) * ease(dt, 8);
    view.blend = clamp(view.blend + (first ? dt : -dt) / FLIGHT, 0, 1);
    const t = smooth(view.blend);

    // The owner is put at the door once the building is here, and the camera starts there, not at the origin.
    if (owner.placed && !placed.current) { placed.current = true; snap.current = true; }
    // The overview pose, eased the way it always was.
    focus.current.lerp(iso.set(owner.pos.x, owner.pos.y + 0.6, owner.pos.z), ease(dt, snap.current ? 100 : 5));
    const fx = Math.sin(view.yaw), fz = Math.cos(view.yaw), c = Math.cos(ISO_PITCH);
    isoLook.copy(focus.current);
    want.set(isoLook.x - fx * c * view.isoDist, isoLook.y + Math.sin(ISO_PITCH) * view.isoDist, isoLook.z - fz * c * view.isoDist);
    if (snap.current) isoPos.copy(want); else isoPos.lerp(want, ease(dt, 5));

    // The eye pose. The bob is small and fades with speed.
    const bob = Math.sin(runtime.time * 9) * 0.02 * Math.min(1, owner.speed / 3);
    eye.set(owner.pos.x + fx * 0.1, owner.pos.y + EYE + bob, owner.pos.z + fz * 0.1);
    const cp = Math.cos(view.fpPitch);
    eyeLook.set(eye.x + fx * cp, eye.y + Math.sin(view.fpPitch), eye.z + fz * cp);

    cam.position.lerpVectors(isoPos, eye, t);
    look.lerpVectors(isoLook, eyeLook, t);
    snap.current = false;
    cam.lookAt(look);
    const fov = FOV_ISO + (FOV_FIRST - FOV_ISO) * t;
    if (Math.abs(cam.fov - fov) > 0.001 || cam.near !== 0.1) { cam.fov = fov; cam.near = 0.1; cam.updateProjectionMatrix(); }
    // Read by verify/e2e-camera.mjs. ownerVisible asks the scene graph itself whether the owner's body would be drawn.
    const ownerVisible = () => {
      for (const e of crowd) {
        const p = e.joints.root.getWorldPosition(probe);
        if (e.hidden || Math.hypot(p.x - owner.pos.x, p.z - owner.pos.z) > 0.05) continue;
        let shown = true;
        for (let n: Object3D | null = e.joints.root; n; n = n.parent) if (!n.visible) shown = false;
        if (shown) return true;
      }
      return false;
    };
    (window as unknown as { __officeCamera: unknown }).__officeCamera = { ownerVisible, x: cam.position.x, y: cam.position.y, z: cam.position.z, fov: cam.fov, blend: view.blend, yaw: view.yaw, pitch: view.fpPitch, locked: locked.current };
  }, -1);
  return null;
}
