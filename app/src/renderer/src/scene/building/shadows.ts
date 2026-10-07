// A soft shadow that has the shape of the thing that casts it. Each model's top-down silhouette is painted once into an atlas, blurred
// by how tall the thing is, and one instanced mesh lays them under every small prop and every desk's computer. A mug throws a round
// patch, a notebook a rectangle, a pair of headphones two cups and a band, and no two kinds share a blob.
import { BufferGeometry, CanvasTexture, InstancedBufferAttribute, LinearFilter, MeshBasicMaterial, PlaneGeometry } from 'three';

const CELL_PX = 128;
const ATLAS_PX = 1024;
const PER_ROW = ATLAS_PX / CELL_PX;
// Away from the sun (Lighting.tsx puts it at +x, +z), as a unit direction in the floor plane.
const AWAY = { x: -0.94, z: -0.34 };
/** How far a shadow lies from the thing, per meter of its height. */
const THROW = 0.45;

/** Where a silhouette sits in the atlas (`rect`: u0, v0, du, dv) and how far it reaches from the model's origin, in meters. */
export type Shape = { rect: readonly [number, number, number, number]; half: number; height: number };

let canvas: HTMLCanvasElement | null = null;
let texture: CanvasTexture | null = null;
const shapes = new Map<string, Shape>();

const atlas = () => {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = ATLAS_PX;
    texture = new CanvasTexture(canvas);
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
  }
  return { canvas, texture: texture! };
};

/** Paints the top faces of `geometry` (the whole footprint seen from above) into a cell of the atlas, blurred by `blur` px, and returns where. */
function paint(geometry: BufferGeometry, height: number): Shape {
  const { canvas: atlasCanvas, texture } = atlas();
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const at = (i: number) => (index ? index.getX(i) : i);
  let reach = 0.05;
  for (let i = 0; i < pos.count; i++) reach = Math.max(reach, Math.abs(pos.getX(i)), Math.abs(pos.getZ(i)));
  // A taller thing throws a softer shadow. The cell reaches three blur radii past the silhouette, so the blur is not cut off at its edge.
  const blur = Math.min(8, 1.2 + height * 14);
  const half = (reach + 0.02) / (1 - (3 * blur) / (CELL_PX / 2));
  const k = CELL_PX / (2 * half);
  const tight = document.createElement('canvas');
  tight.width = tight.height = CELL_PX;
  const g = tight.getContext('2d')!;
  g.fillStyle = '#000';
  const [a, b, c] = [0, 0, 0].map(() => [0, 0, 0]);
  for (let i = 0; i < count; i += 3) {
    const tri = [a, b, c];
    tri.forEach((p, n) => {
      const v = at(i + n);
      p[0] = pos.getX(v);
      p[1] = pos.getY(v);
      p[2] = pos.getZ(v);
    });
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz) || 1;
    if (ny / len < 0.5) continue;
    g.beginPath();
    g.moveTo(CELL_PX / 2 + a[0] * k, CELL_PX / 2 + a[2] * k);
    g.lineTo(CELL_PX / 2 + b[0] * k, CELL_PX / 2 + b[2] * k);
    g.lineTo(CELL_PX / 2 + c[0] * k, CELL_PX / 2 + c[2] * k);
    g.closePath();
    g.fill();
  }
  const n = shapes.size;
  const [col, row] = [n % PER_ROW, Math.floor(n / PER_ROW) % PER_ROW];
  const ctx = atlasCanvas.getContext('2d')!;
  ctx.save();
  ctx.beginPath();
  ctx.rect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
  ctx.clip();
  ctx.clearRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
  ctx.globalAlpha = 0.5;
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(tight, col * CELL_PX, row * CELL_PX);
  ctx.globalAlpha = 0.5;
  ctx.filter = 'blur(0.8px)';
  ctx.drawImage(tight, col * CELL_PX, row * CELL_PX);
  ctx.restore();
  texture.needsUpdate = true;
  return { rect: [(col * CELL_PX) / ATLAS_PX, 1 - ((row + 1) * CELL_PX) / ATLAS_PX, CELL_PX / ATLAS_PX, CELL_PX / ATLAS_PX], half, height };
}

/** The shape of `key`, painted the first time it is asked for, or null once the atlas has no cell left. `source` gives the model and its height. */
export function shapeOf(key: string, source: () => { geometry: BufferGeometry; height: number }): Shape | null {
  let shape = shapes.get(key);
  if (!shape) {
    if (shapes.size >= PER_ROW * PER_ROW) return null;
    const { geometry, height } = source();
    shape = paint(geometry, height);
    shapes.set(key, shape);
  }
  return shape;
}

/** One shadow to lay: where the thing stands, the way it is turned, and the shape it casts. */
export type Spot = { x: number; y: number; z: number; yaw: number; shape: Shape };

/** What an instanced mesh needs to draw `spots`: one plane per spot, put and turned at fill time, reading its own cell of the atlas. */
export function shadowMesh(count: number) {
  const geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  geometry.setAttribute('uvRect', new InstancedBufferAttribute(new Float32Array(count * 4), 4));
  return geometry;
}

export const shadowMaterial = () => {
  const material = new MeshBasicMaterial({ map: atlas().texture, transparent: true, depthWrite: false, opacity: 1, polygonOffset: true, polygonOffsetFactor: -4 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 uvRect;').replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = uvRect.xy + uv * uvRect.zw;\n#endif');
  };
  return material;
};

/** Where the middle of a shadow lies: from the thing, away from the sun, further for a taller thing. */
export const throwOf = (height: number) => ({ x: AWAY.x * height * THROW, z: AWAY.z * height * THROW });
