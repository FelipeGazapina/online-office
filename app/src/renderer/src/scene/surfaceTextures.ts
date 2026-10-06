import { LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, type Texture } from 'three';
import { bitmapTexture } from './bitmapTexture.ts';
import carpetDiff from '../assets/textures/carpet/diff.jpg';
import carpetArm from '../assets/textures/carpet/arm.jpg';
import carpetNor from '../assets/textures/carpet/nor.jpg';
import concreteDiff from '../assets/textures/concrete/diff.jpg';
import concreteArm from '../assets/textures/concrete/arm.jpg';
import concreteNor from '../assets/textures/concrete/nor.jpg';
import plasterDiff from '../assets/textures/plaster/diff.jpg';
import plasterArm from '../assets/textures/plaster/arm.jpg';
import plasterNor from '../assets/textures/plaster/nor.jpg';
import tileDiff from '../assets/textures/tile/diff.jpg';
import tileArm from '../assets/textures/tile/arm.jpg';
import tileNor from '../assets/textures/tile/nor.jpg';
import woodDiff from '../assets/textures/wood/diff.jpg';
import woodArm from '../assets/textures/wood/arm.jpg';
import woodNor from '../assets/textures/wood/nor.jpg';

// Real CC0 surfaces (see app/assets-LICENSES.md), bundled with the app. Each is a colour map that vertex colours tint, a GL
// normal map and an "ARM" map: ambient occlusion in red, roughness in green. The same ARM texture feeds aoMap and roughnessMap.
export type Surface = { map: Texture; normalMap: Texture; armMap: Texture };

const load = (url: string, srgb: boolean, repeat: number): Texture => {
  const t = bitmapTexture(url, { srgb, flipY: true });
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
};

/** `size` is how many metres one repeat of the image covers. */
const surface = (diff: string, nor: string, arm: string, size: number): Surface => {
  const repeat = 1 / size;
  return { map: load(diff, true, repeat), normalMap: load(nor, false, repeat), armMap: load(arm, false, repeat) };
};

const once = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

export const carpetSurface = once(() => surface(carpetDiff, carpetNor, carpetArm, 0.9));
export const tileSurface = once(() => surface(tileDiff, tileNor, tileArm, 1.8));
export const concreteSurface = once(() => surface(concreteDiff, concreteNor, concreteArm, 2));
export const woodSurface = once(() => surface(woodDiff, woodNor, woodArm, 1.6));
export const PLASTER_METRES = 2;
/** The plaster colour map's average in linear light, which the wall shader divides out so a wall's paint keeps its own colour. */
export const PLASTER_MEAN: [number, number, number] = [0.342, 0.262, 0.188];
export const plasterSurface = once(() => surface(plasterDiff, plasterNor, plasterArm, PLASTER_METRES));
