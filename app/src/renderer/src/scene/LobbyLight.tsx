import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, type Group, MeshBasicMaterial } from 'three';
import type { Building } from '../../../shared/space/index.ts';
import { runtime } from '../runtime.ts';
import { poolTexture } from './textures.ts';
import { lobbyVoid, type VoidRect } from './lobbyVoid.ts';
import { CLERESTORY, END_WINDOWS, endWindowZs } from './LobbyVoid.tsx';
import type { Bounds } from './Environment.tsx';

// The lobby's own sun: the street-front windows throw crisp patches of light across the floor, with the frame's jambs and
// mullion left as dark stripes, and a faint haze of dust in the beam between each window and its patch. It follows the
// direction of the scene's sun light, so a patch lands where the shadow map says light comes in. Patches and haze are two
// meshes built once, plus two shade decals. Only drawn at eye height, where the sun is low.
const SILL = 0.6;
const HEAD = 2.85;
// The sun's travel per metre of drop, from the sun light's position (cx + 38, 12, cz + 14) toward the middle of the lot.
const DX = -38 / 12;
const DZ = -14 / 12;
const WARM: [number, number, number] = [1, 0.74, 0.42];

type Pt = [number, number, number];

/** Where a point of the window opening lands on the floor along the sun's ray. */
const land = (x: number, y: number, z: number, x0: number, z0 = -99): Pt => [Math.max(x0 + 0.3, x + DX * y), 0.035, Math.max(z0, z + DZ * y)];

function sunGeometry(b: Bounds, walls: readonly { x: number; z: number; d: string; open?: string }[], lift: VoidRect | null) {
  const patch: number[] = [];
  const patchColor: number[] = [];
  const haze: number[] = [];
  const hazeColor: number[] = [];
  const tri = (out: number[], col: number[], a: Pt, c: Pt, d: Pt, ia: number, ic: number, id: number) => {
    for (const [p, i] of [[a, ia], [c, ic], [d, id]] as [Pt, number][]) {
      out.push(...p);
      col.push(WARM[0] * i, WARM[1] * i, WARM[2] * i);
    }
  };
  const quad = (out: number[], col: number[], p: Pt, q: Pt, r: Pt, s: Pt, ip: number, iq: number, ir: number, is: number) => {
    tri(out, col, p, q, r, ip, iq, ir);
    tri(out, col, p, r, s, ip, ir, is);
  };
  // One window opening: its rim on the glass, the patch it throws and the faces of the beam between them.
  const opening = (a: Pt, c: Pt, y0: number, y1: number, zClip: number, k = 1) => {
    // a and c are the opening's two lower corners along its width, at height 0; y0..y1 is its height.
    const at = (p: Pt, y: number): Pt => [p[0], y, p[2]];
    const n0 = land(a[0], y0, a[2], b.x0, zClip);
    const n1 = land(c[0], y0, c[2], b.x0, zClip);
    const f1 = land(c[0], y1, c[2], b.x0, zClip);
    const f0 = land(a[0], y1, a[2], b.x0, zClip);
    quad(patch, patchColor, n0, n1, f1, f0, k, k, 0.55 * k, 0.55 * k);
    const g0 = at(a, y0);
    const g1 = at(c, y0);
    const g2 = at(c, y1);
    const g3 = at(a, y1);
    quad(haze, hazeColor, g3, g0, n0, f0, 0.5 * k, 0.5 * k, 0.15 * k, 0);
    quad(haze, hazeColor, g2, g1, n1, f1, 0.5 * k, 0.5 * k, 0.15 * k, 0);
    quad(haze, hazeColor, g3, g2, f1, f0, 0.5 * k, 0.5 * k, 0, 0);
  };
  for (const w of walls) {
    if (w.d !== 'e' || w.z !== b.z1 || w.open !== 'window') continue;
    for (const [a, c] of [[0.05, 0.485], [0.515, 0.95]]) opening([w.x + a, 0, b.z1 - 0.1], [w.x + c, 0, b.z1 - 0.1], SILL, HEAD, -99);
  }
  if (lift) {
    // The clerestory over the front wall, between its mullions, and the three tall windows in the brick end wall.
    for (let x = lift.x0; x < lift.x1; x += CLERESTORY.pitch) opening([x + 0.06, 0, b.z1 - 0.1], [Math.min(x + CLERESTORY.pitch - 0.06, lift.x1), 0, b.z1 - 0.1], CLERESTORY.y0, CLERESTORY.y1, lift.z0 + 0.3, 0.4);
    for (const z of endWindowZs(lift)) opening([lift.x1 - 0.12, 0, z - END_WINDOWS.w / 2], [lift.x1 - 0.12, 0, z + END_WINDOWS.w / 2], END_WINDOWS.y0, END_WINDOWS.y1, lift.z0 + 0.3, 0.12);
  }
  const make = (pos: number[], col: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    return g;
  };
  return { patch: make(patch, patchColor), haze: make(haze, hazeColor) };
}

const patchMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.42, side: DoubleSide, toneMapped: false });
const hazeMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, opacity: 0.05, side: DoubleSide, toneMapped: false });
const shadeMaterial = new MeshBasicMaterial({ map: poolTexture(), color: '#1a1008', transparent: true, depthWrite: false, opacity: 0.55, fog: false, polygonOffset: true, polygonOffsetFactor: -2 });

/** A pool of shade on the floor: the far side of the hall, away from the windows, so the lit patches read against it. */
function Shade({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  return (
    <mesh position={[x, 0.03, z]} rotation-x={-Math.PI / 2} material={shadeMaterial} renderOrder={3}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

export function LobbySun({ b, building }: { b: Bounds; building: Building }) {
  const walls = building.stories[0]?.walls ?? [];
  const lift = useMemo(() => lobbyVoid(building), [building]);
  const geo = useMemo(() => sunGeometry(b, walls, lift), [b.x0, b.x1, b.z1, walls, lift]);
  const group = useRef<Group>(null);
  // Strongest at eye height; gone in the overview, where the sun stands high and the shadows are light.
  useFrame(() => {
    const eye = Math.min(1, runtime.view.blend * 4);
    patchMaterial.opacity = 0.42 * eye;
    hazeMaterial.opacity = 0.05 * eye;
    shadeMaterial.opacity = 0.55 * eye;
    if (group.current) group.current.visible = eye > 0.01;
  });
  const right = b.x1;
  return (
    <group ref={group}>
      <mesh geometry={geo.patch} material={patchMaterial} renderOrder={5} frustumCulled={false} />
      <mesh geometry={geo.haze} material={hazeMaterial} renderOrder={6} frustumCulled={false} />
      <Shade x={(b.x0 + right) / 2} z={3.4} w={right - b.x0 + 4} d={3} />
      <Shade x={right - 1.5} z={5.5} w={5} d={9} />
    </group>
  );
}
