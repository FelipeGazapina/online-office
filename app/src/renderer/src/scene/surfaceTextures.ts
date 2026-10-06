import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';

// Procedural tiling surfaces drawn to canvas once: a colour map that vertex colours tint, a normal map and a roughness map
// both derived from the colour map's own light and dark, so seams, grout and fibres are also dips and rougher patches.
export type Surface = { map: CanvasTexture; normalMap: CanvasTexture; roughnessMap: CanvasTexture };

const rng = (seed: number) => {
  let s = seed;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};

const texture = (c: HTMLCanvasElement, srgb: boolean, repeat: number) => {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
};

const canvas = (size: number) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
};

/** Sobel over the colour map's luminance, wrapping at the edges so the result tiles. Light reads as high. */
function derive(source: HTMLCanvasElement, bump: number, rough: [number, number]) {
  const n = source.width;
  const px = source.getContext('2d')!.getImageData(0, 0, n, n).data;
  const lum = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) lum[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
  const at = (x: number, y: number) => lum[((y + n) % n) * n + ((x + n) % n)];
  const normal = canvas(n);
  const roughness = canvas(n);
  const ng = normal.getContext('2d')!;
  const rg = roughness.getContext('2d')!;
  const nd = ng.createImageData(n, n);
  const rd = rg.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const nx = -dx * bump;
      const ny = dy * bump;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * n + x) * 4;
      nd.data[i] = (nx * inv * 0.5 + 0.5) * 255;
      nd.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nd.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      nd.data[i + 3] = 255;
      const r = (rough[0] + (rough[1] - rough[0]) * (1 - lum[y * n + x])) * 255;
      rd.data[i] = rd.data[i + 1] = rd.data[i + 2] = r;
      rd.data[i + 3] = 255;
    }
  }
  ng.putImageData(nd, 0, 0);
  rg.putImageData(rd, 0, 0);
  return { normal, roughness };
}

function build(colour: HTMLCanvasElement, repeat: number, bump: number, rough: [number, number]): Surface {
  const { normal, roughness } = derive(colour, bump, rough);
  return { map: texture(colour, true, repeat), normalMap: texture(normal, false, repeat), roughnessMap: texture(roughness, false, repeat) };
}

/** Wrap-aware blob so a stain or vein crossing an edge continues on the other side. */
const wrapped = (n: number, x: number, y: number, r: number, draw: (x: number, y: number) => void) => {
  for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) if (x + ox > -r && x + ox < n + r && y + oy > -r && y + oy < n + r) draw(x + ox, y + oy);
};

let carpet: Surface | null = null;
/** Office carpet tiles, half a metre a side, each a little lighter or darker than its neighbour, over looped pile. */
export function carpetSurface(): Surface {
  if (carpet) return carpet;
  const n = 512;
  const c = canvas(n);
  const g = c.getContext('2d')!;
  const r = rng(41);
  const half = n / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const l = 198 + r() * 50;
      g.fillStyle = `rgb(${l},${l},${l})`;
      g.fillRect(tx * half, ty * half, half, half);
    }
  }
  for (let i = 0; i < 90; i++) {
    const x = r() * n, y = r() * n, rad = 24 + r() * 50;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, r() < 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(120,120,120,0.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    wrapped(n, x, y, rad, (px, py) => { g.beginPath(); g.arc(px, py, rad, 0, 6.3); g.fill(); });
  }
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  for (let i = 0; i < 26000; i++) {
    const x = r() * n, y = r() * n, a = r() * 6.3, len = 3 + r() * 5;
    g.strokeStyle = r() < 0.5 ? 'rgba(70,70,70,0.34)' : 'rgba(255,255,255,0.5)';
    wrapped(n, x, y, 9, (px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke(); });
  }
  g.fillStyle = 'rgba(30,30,30,0.5)';
  for (let k = 0; k < 2; k++) {
    g.fillRect(k * half - 3, 0, 6, n);
    g.fillRect(0, k * half - 3, n, 6);
  }
  g.fillRect(0, 0, 3, n);
  g.fillRect(0, 0, n, 3);
  g.fillRect(n - 3, 0, 3, n);
  g.fillRect(0, n - 3, n, 3);
  return (carpet = build(c, 1, 2.6, [0.8, 1]));
}

let tile: Surface | null = null;
/** Polished stone tiles, 0.6 m a side, four to a repeat, with grout lines and soft veining that differs tile to tile. */
export function tileSurface(): Surface {
  if (tile) return tile;
  const n = 512;
  const c = canvas(n);
  const g = c.getContext('2d')!;
  const r = rng(77);
  const half = n / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const l = 232 + r() * 20;
      g.fillStyle = `rgb(${l},${l},${l - 3})`;
      g.fillRect(tx * half, ty * half, half, half);
      g.save();
      g.beginPath();
      g.rect(tx * half, ty * half, half, half);
      g.clip();
      for (let v = 0; v < 5; v++) {
        g.strokeStyle = `rgba(110,110,118,${0.1 + r() * 0.16})`;
        g.lineWidth = 1 + r() * 2.2;
        g.beginPath();
        let x = tx * half + r() * half, y = ty * half + r() * half;
        g.moveTo(x, y);
        for (let s = 0; s < 6; s++) {
          x += (r() - 0.35) * 70;
          y += (r() - 0.5) * 70;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.restore();
    }
  }
  g.fillStyle = '#9a9890';
  const grout = 5;
  for (let k = 0; k < 2; k++) {
    g.fillRect(k * half - grout / 2, 0, grout, n);
    g.fillRect(0, k * half - grout / 2, n, grout);
    g.fillRect(n - grout / 2, 0, grout / 2, n);
    g.fillRect(0, n - grout / 2, n, grout / 2);
  }
  return (tile = build(c, 1 / 1.2, 3.4, [0.22, 0.5]));
}

let concrete: Surface | null = null;
/** Poured concrete in two-metre slabs: fine pits and trowel mottling, a saw joint on every edge. */
export function concreteSurface(): Surface {
  if (concrete) return concrete;
  const n = 512;
  const c = canvas(n);
  const g = c.getContext('2d')!;
  const r = rng(19);
  g.fillStyle = '#d9d9d9';
  g.fillRect(0, 0, n, n);
  for (let i = 0; i < 90; i++) {
    const x = r() * n, y = r() * n, rad = 25 + r() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, r() < 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(90,90,90,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    wrapped(n, x, y, rad, (px, py) => { g.beginPath(); g.arc(px, py, rad, 0, 6.3); g.fill(); });
  }
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() < 0.6 ? 'rgba(70,70,70,0.35)' : 'rgba(255,255,255,0.4)';
    const s = 1 + r() * 1.8;
    g.fillRect(r() * n, r() * n, s, s);
  }
  g.fillStyle = 'rgba(60,60,60,0.8)';
  g.fillRect(0, 0, 3, n);
  g.fillRect(0, 0, n, 3);
  return (concrete = build(c, 1 / 2, 2.6, [0.6, 0.95]));
}

/** Wood already has its colour map; this adds the matching normal and roughness maps to it. */
export function woodSurface(colour: HTMLCanvasElement, repeat: number): Surface {
  return build(colour, repeat, 2.4, [0.5, 0.88]);
}
