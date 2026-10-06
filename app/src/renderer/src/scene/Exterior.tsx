import { useMemo } from 'react';
import { MeshBasicMaterial, MeshStandardMaterial, type BufferGeometry } from 'three';
import { DOOR_X } from '../../../shared/space/index.ts';
import { box, cyl, merge } from './building/models.ts';
import { detail } from './shading.ts';
import { pottedPlant } from './Decor.tsx';
import { useCanvasTexture } from './textures.ts';
import { GROUND_Y, type Bounds } from './Environment.tsx';

// What stands outside the walls, each group merged into one mesh: the porch with its canopy, the foundation lip, the
// parking plaza with its cars and the lamp posts. Everything is vertex-colored, so the whole exterior is a handful of draws.
const exteriorMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), 'furniture');
const glowMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const STONE = '#c9c0b0';
const STONE_DARK = '#a79d8c';
const TRIM = '#f4efe6';
const BRONZE = '#3a3334';
const ACCENT = '#2f6f73';

function porch(z1: number): { solid: BufferGeometry[]; glow: BufferGeometry[] } {
  const x = DOOR_X;
  const reach = 2.6;
  const solid = [
    box(6.6, 0.5, reach + 0.6, x, -0.25, z1 + reach / 2 + 0.2, STONE),
    box(6.6, 0.05, 0.14, x, 0.02, z1 + reach + 0.45, STONE_DARK),
    box(5.0, 0.2, 0.6, x, -0.3, z1 + reach + 0.9, STONE),
    box(4.2, 0.2, 0.5, x, -0.5, z1 + reach + 1.4, STONE_DARK),
    box(2.4, 0.03, 1.1, x, 0.02, z1 + 0.9, '#7f3b36'),
    box(6.4, 0.16, reach + 0.3, x, 3.08, z1 + reach / 2 + 0.1, TRIM),
    box(6.4, 0.26, 0.12, x, 2.96, z1 + reach + 0.25, ACCENT),
    box(6.6, 0.05, reach + 0.5, x, 3.2, z1 + reach / 2 + 0.1, STONE_DARK),
    ...[-2.9, 2.9].flatMap((dx) => [cyl(0.12, 0.12, 2.9, x + dx, 1.65, z1 + reach, TRIM, 12), cyl(0.2, 0.2, 0.14, x + dx, 0.07, z1 + reach, STONE_DARK, 12), cyl(0.2, 0.2, 0.12, x + dx, 3.2, z1 + reach, STONE_DARK, 12)]),
    box(0.1, 2.9, 0.2, x - 1.05, 1.45, z1, BRONZE),
    box(0.1, 2.9, 0.2, x + 1.05, 1.45, z1, BRONZE),
    box(2.2, 0.12, 0.2, x, 2.78, z1, BRONZE),
    ...pottedPlant(x - 2.8, z1 + 1.1, 1.1),
    ...pottedPlant(x + 2.8, z1 + 1.1, 1.1),
  ];
  const glow = [...[-1.6, 0, 1.6].map((dx) => cyl(0.14, 0.17, 0.08, x + dx, 2.98, z1 + reach - 0.5, '#fff1c4', 10))];
  return { solid, glow };
}

function car(x: number, z: number, color: string, yaw: 0 | 1 = 0): BufferGeometry[] {
  const a = yaw === 0 ? { w: 4.2, d: 1.9 } : { w: 1.9, d: 4.2 };
  const long = (l: number, s: number, ox: number, oy: number, h: number, c: string) =>
    yaw === 0 ? box(l, h, s, x + ox, oy, z, c) : box(s, h, l, x, oy, z + ox, c);
  return [
    long(a.w, a.d, 0, 0.5, 0.5, color),
    long(1.9, a.d - 0.12, -0.25, 1.0, 0.42, '#2f3d4a'),
    long(1.7, a.d - 0.04, -0.25, 1.24, 0.08, color),
    long(0.2, a.d + 0.02, 1.95, 0.4, 0.25, '#2b2e38'),
    ...[-1.35, 1.35].flatMap((o) => [-1, 1].map((sd) => long(0.7, 0.2, o, 0.34, 0.68, '#1c1f27').translate(yaw === 0 ? 0 : sd * (a.d / 2 - 0.02), 0, yaw === 0 ? sd * (a.d / 2 - 0.02) : 0))),
  ];
}

function lamp(x: number, z: number): { solid: BufferGeometry[]; glow: BufferGeometry[] } {
  return {
    solid: [cyl(0.14, 0.18, 0.2, x, 0.1, z, BRONZE, 8), cyl(0.05, 0.07, 4.2, x, 2.2, z, BRONZE, 8), box(0.9, 0.06, 0.08, x, 4.3, z, BRONZE)],
    glow: [cyl(0.22, 0.28, 0.26, x - 0.36, 4.2, z, '#fff1c4', 8), cyl(0.22, 0.28, 0.26, x + 0.36, 4.2, z, '#fff1c4', 8)],
  };
}

function plaza(b: Bounds): { solid: BufferGeometry[]; glow: BufferGeometry[] } {
  const colors = ['#c8553d', '#3f6f9f', '#e9e4da', '#4a5568', '#d9a441', '#6a8f5a'];
  const px = DOOR_X + 17;
  const pz = b.z1 + 9.2;
  const solid: BufferGeometry[] = [];
  [0, 1, 3, 5].forEach((i, n) => solid.push(...car(px - 7 + i * 2.8 + 1.4, pz + 3.1, colors[(n * 2 + 1) % colors.length], 1)));
  solid.push(...car(px - 5.6, pz - 3.3, colors[0], 1), ...car(px + 8.4, pz - 3.3, colors[2], 1));
  // Curb stops along the near bay, a bike rack and a bench by the path.
  for (let i = 0; i < 6; i++) solid.push(box(1.2, 0.16, 0.22, px - 7 + i * 2.8 + 1.4, 0.08, pz + 5.1, '#b6b0a4'));
  for (let i = 0; i < 5; i++) solid.push(box(0.05, 0.6, 0.05, DOOR_X + 7 + i * 0.5, 0.3, b.z1 + 4.9, '#8a9099'), box(0.4, 0.04, 0.04, DOOR_X + 7.2 + i * 0.5, 0.62, b.z1 + 4.9, '#8a9099'));
  solid.push(box(2.0, 0.08, 0.5, DOOR_X - 6.2, 0.5, b.z1 + 6.8, '#8c6a4a'), box(2.0, 0.4, 0.06, DOOR_X - 6.2, 0.75, b.z1 + 7.0, '#8c6a4a'), box(0.1, 0.5, 0.4, DOOR_X - 7.1, 0.25, b.z1 + 6.8, BRONZE), box(0.1, 0.5, 0.4, DOOR_X - 5.3, 0.25, b.z1 + 6.8, BRONZE));
  const glow: BufferGeometry[] = [];
  for (const [lx, lz] of [[DOOR_X + 5.5, b.z1 + 4.2], [DOOR_X - 5.5, b.z1 + 4.2], [px + 10, pz - 5]]) {
    const l = lamp(lx, lz);
    solid.push(...l.solid);
    glow.push(...l.glow);
  }
  for (const g of [...solid, ...glow]) g.translate(0, GROUND_Y, 0);
  return { solid, glow };
}

export function Exterior({ b }: { b: Bounds }) {
  const geo = useMemo(() => {
    const p = porch(b.z1);
    const pl = plaza(b);
    return { solid: merge([...p.solid, ...pl.solid]), glow: merge([...p.glow, ...pl.glow]) };
  }, [b.x0, b.x1, b.z0, b.z1]);
  const lines = useCanvasTexture(1024, 512, (g) => {
    g.fillStyle = '#4a4d55';
    g.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
      g.fillRect((i * 97) % 1024, (i * 53) % 512, 3, 3);
    }
    g.fillStyle = '#e9e6dc';
    for (let i = 0; i <= 6; i++) g.fillRect((4 + i * 2.8) * (1024 / 22), 340, 6, 172);
    g.fillRect(150, 336, 760, 5);
    for (let i = 0; i <= 6; i++) g.fillRect((4 + i * 2.8) * (1024 / 22), 0, 6, 172);
  }, []);
  return (
    <>
      <mesh geometry={geo.solid} material={exteriorMaterial} castShadow receiveShadow />
      <mesh geometry={geo.glow} material={glowMaterial} />
      <mesh rotation-x={-Math.PI / 2} position={[DOOR_X + 17, GROUND_Y + 0.03, b.z1 + 9.2]} receiveShadow>
        <planeGeometry args={[22, 11]} />
        <meshStandardMaterial map={lines} roughness={0.95} />
      </mesh>
    </>
  );
}
