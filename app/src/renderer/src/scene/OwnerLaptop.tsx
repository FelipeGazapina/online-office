// The laptop in the owner's hands. It shows only while it is out: the owner brings it up from the inventory, the lid opens and the
// screen wakes to the desktop of the owner's Mac. scene/laptopPose.ts says where everything is at each moment.
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, type Group, type Mesh } from 'three';
import { laptopAnim } from '../computer.ts';
import { runtime } from '../runtime.ts';
import { box, bbox, merge } from './building/parts.ts';
import { LAPTOP, laptopLocal, phases, SCREEN } from './laptopPose.ts';
import { roundRect, useCanvasTexture } from './textures.ts';

const SHELL = '#c9cdd8';
const DECK = '#b9beca';
const KEYS = '#2b2e38';
const PAD = '#d6dae3';
const LOGO = '#f5b84c';

// The base runs from the hinge (z = 0) back toward the owner, its top at y = 0. The keys sit near the hinge, the trackpad near the owner.
const base = merge([
  bbox(LAPTOP.w, LAPTOP.base, LAPTOP.d, 0, -LAPTOP.base / 2, -LAPTOP.d / 2, SHELL, 0.006),
  box(LAPTOP.w - 0.012, 0.0012, LAPTOP.d - 0.012, 0, 0.0004, -LAPTOP.d / 2, DECK),
  box(0.29, 0.0016, 0.1, 0, 0.0008, -0.075, KEYS),
  box(0.115, 0.0016, 0.07, 0, 0.0008, -0.175, PAD),
]);
// The lid stands up from the hinge (y) with its screen side toward -z, so turning it about x shuts it on the keys or opens it.
const lid = merge([
  bbox(LAPTOP.w, LAPTOP.lid, LAPTOP.shell, 0, LAPTOP.lid / 2, LAPTOP.shell / 2, SHELL, 0.006),
  box(SCREEN.w + 0.012, SCREEN.h + 0.012, 0.001, 0, SCREEN.y, -0.0002, '#14161c'),
  box(0.034, 0.034, 0.001, 0, LAPTOP.lid / 2 + 0.01, LAPTOP.shell + 0.0004, LOGO),
]);
const screen = new PlaneGeometry(SCREEN.w, SCREEN.h).rotateY(Math.PI);
const shellMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35 });
const DARK = new Color('#05070b');
const LIT = new Color('#ffffff');

// What the screen shows while the camera is on its way in: the look of the owner's desktop (MacPortal.tsx's `.mac-portal`), so the
// moment the real desktop takes over is a sharpening, not a change.
function drawDesktop(g: CanvasRenderingContext2D) {
  const { width: w, height: h } = g.canvas;
  const sky = g.createLinearGradient(0, 0, w, h);
  sky.addColorStop(0, '#202a43');
  sky.addColorStop(0.55, '#314d70');
  sky.addColorStop(1, '#6b91a2');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(18, 24, 40, 0.72)';
  g.fillRect(0, 0, w, 34);
  g.fillStyle = LOGO;
  roundRect(g, 12, 8, 18, 18, 5);
  g.fill();
  const pane = (x: number, y: number, pw: number, ph: number) => {
    g.fillStyle = 'rgba(250, 250, 252, 0.96)';
    roundRect(g, x, y, pw, ph, 9);
    g.fill();
    g.fillStyle = '#f0eff3';
    roundRect(g, x, y, pw, 22, 9);
    g.fill();
    ['#ef6a68', '#e5b34e', '#65b877'].forEach((c, i) => {
      g.fillStyle = c;
      g.beginPath();
      g.arc(x + 14 + i * 12, y + 11, 3.5, 0, Math.PI * 2);
      g.fill();
    });
    g.fillStyle = '#d9d9e3';
    for (let r = 0; r < 4; r++) g.fillRect(x + 16, y + 40 + r * 18, pw * (r % 2 ? 0.5 : 0.7), 7);
  };
  // Laid out as the desktop lays out its windows: the office and its settings on the left, the computer's own window on the right.
  pane(w * 0.035, 56, w * 0.44, h * 0.38);
  pane(w * 0.035, 56 + h * 0.42, w * 0.44, h * 0.5);
  pane(w * 0.52, 56, w * 0.44, h * 0.32);
}

export function OwnerLaptop() {
  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const hinge = useRef<Group>(null);
  const glass = useRef<Mesh>(null);
  const desktop = useCanvasTexture(640, 405, drawDesktop, []);
  const screenMaterial = useMemo(() => new MeshBasicMaterial({ map: desktop, toneMapped: false, color: DARK.clone() }), [desktop]);
  const local = useMemo(() => laptopLocal(0), []);

  useFrame(() => {
    const s = laptopAnim.s;
    const g = root.current;
    if (!g || !body.current || !hinge.current || !glass.current) return;
    g.visible = s > 0;
    if (!g.visible) return;
    const { pos, yaw } = runtime.owner;
    g.position.copy(pos);
    g.rotation.y = yaw;
    laptopLocal(s, local);
    body.current.position.copy(local.at);
    body.current.rotation.set(local.tip, local.spin, 0);
    body.current.scale.setScalar(local.scale);
    hinge.current.rotation.x = local.lid;
    // The screen wakes as the lid comes up, the way a laptop does.
    const lit = phases(s).lid;
    (glass.current.material as MeshBasicMaterial).color.copy(DARK).lerp(LIT, lit * lit);
  });

  return (
    <group ref={root} visible={false} userData={{ laptop: true }}>
      <group ref={body}>
        <mesh geometry={base} material={shellMaterial} castShadow />
        <group ref={hinge}>
          <mesh geometry={lid} material={shellMaterial} castShadow />
          <mesh ref={glass} geometry={screen} material={screenMaterial} position={[0, SCREEN.y, -SCREEN.out]} />
        </group>
      </group>
    </group>
  );
}
