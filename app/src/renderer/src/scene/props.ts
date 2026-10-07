import { MeshStandardMaterial, type BufferGeometry, type Mesh, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bitmapTexture, readFile } from './bitmapTexture.ts';
import { showAo } from './shading.ts';

// Hero props baked from CC0 models (see assets/bake/bake-props.mjs and app/assets-LICENSES.md): each is one mesh with one material,
// origin at the middle of its footprint, standing on y = 0 and facing +z, so a prop stays one instanced draw call.
// <name>.glb holds the geometry; <name>-diff/-nor/-arm.jpg hold the maps. A prop without maps (the chair) carries vertex colours.
const FILES = import.meta.glob('../assets/models/*', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const fileOf = (name: string) => {
  const url = FILES[`../assets/models/${name}`];
  if (!url) throw new Error(`Missing bundled asset ${name}`);
  return url;
};

export type PropName =
  | 'armchair'
  | 'bookshelf'
  | 'chair'
  | 'desk'
  | 'desk_clock'
  | 'desk_lamp'
  | 'lamp'
  | 'laptop'
  | 'picture_frame'
  | 'plant_ficus'
  | 'plant_succulent'
  | 'plant_syngonium'
  | 'plant_tall'
  | 'sofa'
  | 'vase';
const NAMES: readonly PropName[] = ['armchair', 'bookshelf', 'chair', 'desk', 'desk_clock', 'desk_lamp', 'lamp', 'laptop', 'picture_frame', 'plant_ficus', 'plant_succulent', 'plant_syngonium', 'plant_tall', 'sofa', 'vase'];
// The photographed albedo of dark woods and leather is lower than the stylised light the scene is lit for; a gain lifts it.
const GAIN: Partial<Record<PropName, number>> = { desk: 1.6, sofa: 1.2, bookshelf: 1.4, armchair: 1.6, lamp: 1.7 };
export type Prop = { geometry: BufferGeometry; material: MeshStandardMaterial };

const loaded = new Map<PropName, Prop>();

const parse = (buffer: ArrayBuffer) =>
  new Promise<Mesh>((resolve, reject) =>
    new GLTFLoader().parse(
      buffer,
      '',
      (g) => {
        let found: Mesh | undefined;
        g.scene.traverse((o) => {
          if (!found && (o as Mesh).isMesh) found = o as Mesh;
        });
        found ? resolve(found) : reject(new Error('A prop model has no mesh'));
      },
      reject,
    ),
  );

// glTF UVs run from the top, so these textures are not flipped.
const map = (url: string, srgb: boolean): Texture => {
  const t = bitmapTexture(url, { srgb, flipY: false });
  t.anisotropy = 8;
  return t;
};

async function load(name: PropName): Promise<Prop> {
  const mesh = await parse(await readFile(fileOf(`${name}.glb`)));
  const side = (mesh.material as MeshStandardMaterial).side;
  const textured = `../assets/models/${name}-diff.jpg` in FILES;
  const arm = textured ? map(fileOf(`${name}-arm.jpg`), false) : undefined;
  const material = new MeshStandardMaterial(
    textured
      ? { map: map(fileOf(`${name}-diff.jpg`), true), normalMap: map(fileOf(`${name}-nor.jpg`), false), roughnessMap: arm, metalnessMap: arm, aoMap: arm, side }
      : { vertexColors: true, roughness: 0.6, side },
  );
  if (textured) showAo(material);
  const gain = GAIN[name];
  if (gain) material.color.setScalar(gain);
  return { geometry: mesh.geometry, material };
}

let ready: Promise<void> | undefined;
/** Decodes every prop once. The scene waits on this before it draws a single instance. */
export function loadProps(): Promise<void> {
  ready ??= Promise.all(NAMES.map(async (name) => loaded.set(name, await load(name)))).then(() => void performance.mark('office-props-ready'));
  return ready;
}

export const propOf = (name: PropName): Prop => {
  const p = loaded.get(name);
  if (!p) throw new Error(`Prop ${name} used before loadProps() finished`);
  return p;
};
