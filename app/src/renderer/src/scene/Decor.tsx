import { useLayoutEffect, useMemo, useRef } from 'react';
import { BufferGeometry, Float32BufferAttribute, type InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { box, blob, cyl, leafMass, merge } from './building/models.ts';
import { art, shelf } from './building/decorParts.ts';
import { propOf } from './props.ts';
import { detail } from './shading.ts';

// Set dressing that the building model has no item for: one merged mesh per room, so a whole room's decor is one draw call.
export const decorMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 'furniture');

const move = (parts: BufferGeometry[], x: number, z: number) => {
  parts.forEach((g) => g.translate(x, 0, z));
  return parts;
};

// A potted plant is a marker, not geometry: a one-vertex mesh that `move` carries along with the room it belongs to, so each room's
// plants can be pulled out afterwards and drawn as instances of the baked plant model. `s` scales the plant; 1 is about 1.1 m tall,
// the size of a floor plant in a real office.
export const pottedPlant = (x: number, z: number, s = 1): BufferGeometry[] => {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([x, 0, z], 3));
  g.userData.plantScale = s;
  return [g];
};

type PlantSpot = { x: number; y: number; z: number; s: number };
/** Pulls the plant markers out of a room's parts, leaving the parts that merge into the room's mesh. */
export function splitPlants(parts: BufferGeometry[]): { rest: BufferGeometry[]; plants: PlantSpot[] } {
  const plants: PlantSpot[] = [];
  const rest: BufferGeometry[] = [];
  for (const g of parts) {
    const at = g.getAttribute('position');
    if (g.userData.plantScale === undefined) rest.push(g);
    else plants.push({ x: at.getX(0), y: at.getY(0), z: at.getZ(0), s: g.userData.plantScale as number });
  }
  return { rest, plants };
}
function mergeRoom(parts: BufferGeometry[]): { geo: BufferGeometry; plants: PlantSpot[] } {
  const { rest, plants } = splitPlants(parts);
  return { geo: merge(rest), plants };
}

export function Plants({ spots }: { spots: PlantSpot[] }) {
  const { geometry, material } = propOf('plant_ficus');
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new Matrix4();
    spots.forEach(({ x, y, z, s }, i) => m.setMatrixAt(i, mat.compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), i * 2.4), new Vector3(s, s, s))));
    m.instanceMatrix.needsUpdate = true;
  }, [spots]);
  if (!spots.length) return null;
  return <instancedMesh key={spots.length} ref={ref} args={[geometry, material, spots.length]} frustumCulled={false} castShadow receiveShadow />;
}

function kitchen(): BufferGeometry[] {
  return [
    box(0.85, 1.85, 0.75, 2.85, 0.93, -0.1, '#e8ecee'),
    box(0.05, 0.6, 0.04, 2.5, 1.3, 0.3, '#9aa0a6'),
    box(0.5, 0.3, 0.38, -1.2, 1.2, -0.05, '#444a55'),
    box(0.3, 0.2, 0.02, -1.15, 1.2, 0.15, '#1c1f27'),
    cyl(0.18, 0.14, 0.1, 0.4, 1.12, 0.05, '#d9b45a'),
    blob(0.1, 0.35, 1.2, 0.05, '#d95d63'),
    blob(0.1, 0.45, 1.2, 0.0, '#f2b84b'),
    cyl(0.22, 0.22, 0.9, -2.85, 0.45, -0.1, '#cfe3f0'),
    cyl(0.2, 0.2, 0.5, -2.85, 1.15, -0.1, '#9fd0ee'),
    ...[-1.4, 0, 1.4].map((x) => cyl(0.2, 0.22, 0.04, x, 0.78, 0.75, '#b8865e')),
    // The counter's top sits at 1.1 m: a sink with a tap, a microwave, a toaster, a kettle, a fruit bowl and a dish rack.
    box(0.7, 0.03, 0.4, 1.05, 1.11, 0.0, '#8d97a1'),
    box(0.06, 0.28, 0.06, 1.05, 1.26, -0.18, '#c4cad1'),
    box(0.2, 0.05, 0.05, 1.05, 1.4, -0.12, '#c4cad1'),
    box(0.55, 0.3, 0.38, -0.4, 1.26, -0.08, '#e8ecee'),
    box(0.34, 0.2, 0.02, -0.44, 1.26, 0.12, '#1c1f27'),
    box(0.3, 0.17, 0.2, 1.75, 1.19, 0.05, '#d95d63'),
    cyl(0.1, 0.12, 0.22, 1.9, 1.21, -0.15, '#c4cad1', 12),
    cyl(0.2, 0.12, 0.1, 0.1, 1.15, 0.1, '#f1ebe0', 14),
    blob(0.06, 0.05, 1.22, 0.1, '#e5483f'),
    blob(0.06, 0.15, 1.22, 0.06, '#f2b84b'),
    box(0.4, 0.04, 0.3, -1.9, 1.12, 0.0, '#c9a77c'),
  ];
}

function lounge(): BufferGeometry[] {
  return [
    box(1.3, 0.05, 0.7, -1.5, 0.36, 0.9, '#d8b47d'),
    ...[-0.55, 0.55].map((x) => box(0.05, 0.34, 0.05, -1.5 + x, 0.17, 0.9, '#3a3f4e')),
    box(0.5, 0.03, 0.34, -1.6, 0.4, 0.9, '#d95d63'),
    box(0.9, 0.42, 0.9, 2.6, 0.21, 0.2, '#c59e73'),
    box(0.9, 0.5, 0.18, 2.6, 0.6, -0.2, '#b4895e'),
    cyl(0.04, 0.04, 1.5, -3.0, 0.75, -0.6, '#2b2e38', 8),
    cyl(0.22, 0.12, 0.28, -3.0, 1.55, -0.6, '#f8e7b8'),
    cyl(0.16, 0.18, 0.04, -3.0, 0.02, -0.6, '#2b2e38'),
    ...pottedPlant(3.0, -0.7, 1),
    cyl(1.25, 1.25, 0.02, 0.2, 0.012, 0.5, '#c8553d', 28),
    cyl(0.9, 0.9, 0.024, 0.2, 0.014, 0.5, '#f2e4c9', 28),
    box(0.8, 0.45, 0.8, -0.2, 0.22, 1.1, '#d9b45a'),
    box(0.8, 0.5, 0.15, -0.2, 0.62, 1.45, '#c79f48'),
    box(0.32, 0.03, 0.22, -1.5, 0.43, 0.9, '#4f7ea3'),
    box(0.3, 0.03, 0.2, -1.5, 0.46, 0.92, '#e9e4da'),
    cyl(0.07, 0.06, 0.12, -1.3, 0.44, 0.9, '#f1ebe0'),
    ...shelf(-3.4, 0.3, 1.8, 1),
  ];
}

function meeting(): BufferGeometry[] {
  return [
    box(2.4, 1.0, 0.05, 0, 1.75, -1.3, '#14181f'),
    box(2.3, 0.9, 0.02, 0, 1.75, -1.27, '#27527a'),
    box(0.5, 0.35, 0.02, -0.6, 1.9, -1.255, '#6fe0b0'),
    box(0.9, 0.06, 0.02, 0.45, 1.95, -1.255, '#b8d7f4'),
    box(0.9, 0.06, 0.02, 0.45, 1.75, -1.255, '#b8d7f4'),
    box(2.6, 0.04, 0.12, 0, 1.2, -1.3, '#2b2e38'),
    ...pottedPlant(-3.4, -1.1),
    ...pottedPlant(3.4, -1.1),
    ...art(-3.0, 1.7, -1.3, 0.9, 0.7, 1, 1),
    ...art(3.0, 1.7, -1.3, 0.9, 0.7, 1, 2),
  ];
}

// The wall behind the lounge: vertical walnut slats over a dark backing, lit from a groove along the top, with two large pictures.
function slatWall(cx: number, z: number, w: number): BufferGeometry[] {
  const out: BufferGeometry[] = [box(w, 2.7, 0.04, cx, 1.35, z - 0.02, '#3a2a1e'), box(w + 0.1, 0.06, 0.1, cx, 2.72, z - 0.05, '#2b2e38'), box(w + 0.1, 0.1, 0.1, cx, 0.05, z - 0.05, '#2b2e38')];
  const tones = ['#9a6c47', '#8c6038', '#a77a52', '#835a39'];
  for (let i = 0; i < Math.floor(w / 0.15); i++) out.push(box(0.09, 2.6, 0.06 + (i % 3) * 0.015, cx - w / 2 + 0.1 + i * 0.15, 1.35, z - 0.07, tones[i % tones.length]));
  return out;
}

function lobby(cx: number, z1: number, doorX: number): BufferGeometry[] {
  const out: BufferGeometry[] = [
    ...pottedPlant(-6.5, 2.6, 1),
    ...pottedPlant(doorX - 2.4, z1 - 0.8, 1.2),
    ...pottedPlant(doorX + 2.4, z1 - 0.8, 1.2),
    ...slatWall(cx + 1.5, z1, 7.5),
    ...art(cx - 0.6, 1.55, z1 - 0.13, 1.5, 1.0, -1, 0),
    ...art(cx + 3.6, 1.55, z1 - 0.13, 1.1, 1.5, -1, 1),
    ...art(doorX + 14.5, 1.75, z1 - 0.13, 0.8, 1.1, -1, 3),
    box(2.4, 0.46, 0.5, -15.6, 0.23, z1 - 0.6, '#8c6a4a'),
    box(2.4, 0.06, 0.55, -15.6, 0.48, z1 - 0.6, '#c59e73'),
  ];
  return out;
}

export type DecorSpec = { cx: number; z1: number; right: number; doorX: number };

export function LobbyDecor({ cx, z1, right, doorX }: DecorSpec) {
  const { geo, plants } = useMemo(() => {
    const rooms = [
      move(kitchen(), right, z1 - 4.15),
      move(lounge(), right, z1 - 1.75),
      move(meeting(), cx, -0.45),
      lobby(cx, z1, doorX),
    ];
    return mergeRoom(rooms.flat());
  }, [cx, z1, right, doorX]);
  return (
    <>
      <mesh geometry={geo} material={decorMaterial} castShadow receiveShadow />
      <Plants spots={plants} />
    </>
  );
}
