import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BackSide, CanvasTexture, type Group, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Building } from '../../../shared/space/index.ts';
import { STORY_H } from '../../../shared/space/index.ts';
import { runtime } from '../runtime.ts';
import { box, cyl, merge } from './building/models.ts';
import { lobbyVoid, VOID_TOP, type VoidRect } from './lobbyVoid.ts';
import { detail } from './shading.ts';
import { ceilingTexture } from './textures.ts';

// The lobby's double-height hall: the walls rise another three metres, the south front gets a band of tall clerestory
// windows, the end wall is brick with three tall windows, and a high coffered ceiling hangs big pendants on long rods.
// The existing 2.9 m ceiling skips this area (see Ceiling in StoryView). Everything is merged into a few meshes and shown
// only at eye height: from the overview the walls would hide the rooms.
const BASE = STORY_H + 0.05;
const PLASTER = '#efe6d6';
const BRONZE = '#2f2a2b';
const WALNUT = '#8a5b38';

export const CLERESTORY = { y0: 3.7, y1: 6.0, pitch: 1.5 } as const;
export const END_WINDOWS = { y0: 0.9, y1: 5.3, w: 1.5 } as const;

/** The z centres of the end wall's three tall windows. */
export const endWindowZs = (r: VoidRect): number[] => {
  const mid = (r.z0 + r.z1) / 2;
  return [mid - 2.1, mid, mid + 2.1];
};

function shell(r: VoidRect) {
  const len = r.x1 - r.x0;
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const depth = r.z1 - r.z0;
  const h = VOID_TOP - BASE;
  const parts = [
    // South front: a sill band, a header, and bronze mullions with a transom between them. The glass is open air.
    box(len, CLERESTORY.y0 - BASE, 0.24, cx, (BASE + CLERESTORY.y0) / 2, r.z1, PLASTER),
    box(len, VOID_TOP - CLERESTORY.y1, 0.24, cx, (VOID_TOP + CLERESTORY.y1) / 2, r.z1, PLASTER),
    box(len, 0.06, 0.12, cx, 4.9, r.z1, BRONZE),
    // West wall and the end wall's backing.
    box(0.24, h, depth, r.x0, BASE + h / 2, cz, PLASTER),
    box(0.24, h, depth, r.x1, BASE + h / 2, cz, '#9c5c44'),
    // North wall: walnut slats over a dark backing, above the glass partition.
    box(len, h, 0.1, cx, BASE + h / 2, r.z0 - 0.02, '#3a2a1e'),
  ];
  for (let x = r.x0; x <= r.x1 + 0.01; x += CLERESTORY.pitch) parts.push(box(0.08, CLERESTORY.y1 - CLERESTORY.y0, 0.2, x, (CLERESTORY.y0 + CLERESTORY.y1) / 2, r.z1, BRONZE));
  const tones = ['#9a6c47', '#8c6038', '#a77a52', '#835a39'];
  for (let i = 0; i < Math.floor(len / 0.3); i++) parts.push(box(0.14, h - 0.1, 0.09 + (i % 3) * 0.02, r.x0 + 0.2 + i * 0.3, BASE + h / 2, r.z0 + 0.08, tones[i % tones.length]));
  // The brick wall's window frames: bronze reveals around three tall openings.
  for (const z of endWindowZs(r)) {
    const wy = (END_WINDOWS.y0 + END_WINDOWS.y1) / 2;
    const wh = END_WINDOWS.y1 - END_WINDOWS.y0;
    const fx = r.x1 - 0.14;
    parts.push(
      box(0.1, 0.12, END_WINDOWS.w + 0.2, fx, END_WINDOWS.y1 + 0.06, z, BRONZE),
      box(0.18, 0.1, END_WINDOWS.w + 0.3, fx, END_WINDOWS.y0 - 0.05, z, '#d8cdb8'),
      box(0.1, wh, 0.1, fx, wy, z - END_WINDOWS.w / 2 - 0.05, BRONZE),
      box(0.1, wh, 0.1, fx, wy, z + END_WINDOWS.w / 2 + 0.05, BRONZE),
      box(0.08, wh, 0.05, fx, wy, z, BRONZE),
      box(0.08, 0.05, END_WINDOWS.w, fx, wy + 0.4, z, BRONZE),
    );
  }
  return merge(parts);
}

/** Coffer beams on the high ceiling and the pendants that hang from them on long rods. */
function roof(r: VoidRect) {
  const len = r.x1 - r.x0;
  const cz = (r.z0 + r.z1) / 2;
  const depth = r.z1 - r.z0;
  const top = VOID_TOP - 0.28;
  const solid = [box(len, 0.5, 0.36, (r.x0 + r.x1) / 2, top, cz - 1.6, WALNUT), box(len, 0.5, 0.36, (r.x0 + r.x1) / 2, top, cz + 1.6, WALNUT)];
  const glow = [];
  for (let x = r.x0 + 2; x < r.x1; x += 4) solid.push(box(0.32, 0.4, depth, x, top - 0.05, cz, WALNUT));
  for (let x = r.x0 + 4; x < r.x1 - 1; x += 4) {
    for (const z of [cz - 1.6, cz + 1.6]) {
      solid.push(cyl(0.012, 0.012, 2.4, x, top - 1.2, z, BRONZE, 6), cyl(0.1, 0.4, 0.3, x, top - 2.5, z, BRONZE, 20));
      glow.push(cyl(0.36, 0.36, 0.03, x, top - 2.66, z, '#ffd08a', 20));
    }
  }
  return { solid: merge(solid), glow: merge(glow) };
}

let sky: CanvasTexture | null = null;
function skyTexture() {
  if (sky) return sky;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#9fc9f2');
  grad.addColorStop(0.55, '#e4f0fb');
  grad.addColorStop(1, '#ffe7bd');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  sky = new CanvasTexture(c);
  sky.colorSpace = SRGBColorSpace;
  return sky;
}

const shellMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'furniture');
const roofMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, emissive: '#7a5230', emissiveIntensity: 0.55 });
const glowMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
const ceilingMap = ceilingTexture().clone();
ceilingMap.wrapS = ceilingMap.wrapT = RepeatWrapping;
ceilingMap.repeat.set(10, 3);
ceilingMap.needsUpdate = true;
const ceilingMaterial = new MeshStandardMaterial({ map: ceilingMap, roughness: 0.95, side: BackSide, color: '#f0e6d6', emissive: '#fff0d8', emissiveIntensity: 0.22 });
const skyMaterial = new MeshBasicMaterial({ map: skyTexture(), toneMapped: false });

export function LobbyVoid({ building }: { building: Building }) {
  const r = useMemo(() => lobbyVoid(building), [building]);
  const group = useRef<Group>(null);
  useFrame(() => {
    if (group.current) group.current.visible = runtime.view.blend > 0.5;
  });
  const geo = useMemo(() => {
    if (!r) return null;
    const zs = endWindowZs(r);
    const skies = mergeGeometries(
      zs.map((z) => {
        const g = new PlaneGeometry(END_WINDOWS.w, END_WINDOWS.y1 - END_WINDOWS.y0);
        g.rotateY(-Math.PI / 2);
        g.translate(r.x1 - 0.12, (END_WINDOWS.y0 + END_WINDOWS.y1) / 2, z);
        return g;
      }),
    )!;
    return { shell: shell(r), roof: roof(r), sky: skies };
  }, [r]);
  if (!r || !geo) return null;
  return (
    <group ref={group} visible={false}>
      <mesh geometry={geo.shell} material={shellMaterial} />
      <mesh geometry={geo.roof.solid} material={roofMaterial} />
      <mesh geometry={geo.roof.glow} material={glowMaterial} />
      <mesh geometry={geo.sky} material={skyMaterial} />
      <mesh position={[(r.x0 + r.x1) / 2, VOID_TOP, (r.z0 + r.z1) / 2]} rotation-x={-Math.PI / 2} material={ceilingMaterial}>
        <planeGeometry args={[r.x1 - r.x0, r.z1 - r.z0]} />
      </mesh>
    </group>
  );
}
