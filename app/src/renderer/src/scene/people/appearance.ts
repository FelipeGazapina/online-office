import { Color } from 'three';
import type { Look } from './crowd.ts';

export type Outfit = 'tee' | 'hoodie' | 'blazer';
export const HAIR_STYLES = 5;
export const FACES = 6;

export type Appearance = {
  outfit: Outfit;
  hairStyle: number;
  face: number;
  longSleeve: boolean;
  colors: { body: string; trim: string; skin: string; hair: string; pants: string; shoe: string; forearm: string };
};

const PANTS = ['#2f3b52', '#3b3f4a', '#5b4a3a', '#26282f', '#4a5a4f', '#6a5f55'];
const SHOES = ['#f2f0ea', '#20222c', '#7a4a2f', '#c9c3b6'];
const BLAZER = ['#2c3345', '#3a3a40', '#4a3b34', '#27424a'];
const OUTFITS: Outfit[] = ['tee', 'hoodie', 'blazer', 'tee', 'hoodie'];

const hashOf = (s: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h ^ (h >>> 15)) >>> 0;
};
const shade = (hex: string, k: number) => `#${new Color(hex).multiplyScalar(k).getHexString()}`;

const cache = new Map<string, Appearance>();

// Everything a person wears is picked from the look's own colours, so one look always dresses the same.
// The shirt keeps the provider colour (the way you tell teams apart); the rest varies by hash.
export function appearance(look: Look): Appearance {
  const key = `${look.body}${look.skin}${look.hair}${look.trim ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = (n: number, m: number) => hashOf(key, n) % m;
  const outfit = OUTFITS[h(1, OUTFITS.length)];
  const body = outfit === 'tee' ? look.body : outfit === 'hoodie' ? shade(look.body, 0.72) : BLAZER[h(2, BLAZER.length)];
  const longSleeve = outfit !== 'tee';
  const a: Appearance = {
    outfit,
    hairStyle: h(3, HAIR_STYLES),
    face: h(4, FACES),
    longSleeve,
    colors: {
      body,
      trim: look.trim ?? look.body,
      skin: look.skin,
      hair: look.hair,
      pants: PANTS[h(5, PANTS.length)],
      shoe: SHOES[h(6, SHOES.length)],
      forearm: longSleeve ? body : look.skin,
    },
  };
  cache.set(key, a);
  return a;
}
