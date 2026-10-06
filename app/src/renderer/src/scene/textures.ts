import { useEffect, useMemo } from 'react';
import { CanvasTexture, NearestFilter, RepeatWrapping, SRGBColorSpace } from 'three';

export const FONT_DISPLAY = '"Bricolage Grotesque", "Avenir Next", ui-rounded, system-ui, sans-serif';
export const FONT_BODY = '"Instrument Sans", "Avenir Next", system-ui, sans-serif';

// A texture drawn with 2D canvas, redrawn when deps change and once web fonts finish loading.
export function useCanvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, deps: unknown[]) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [w, h]);
  useEffect(() => {
    const g = (tex.image as HTMLCanvasElement).getContext('2d')!;
    const paint = () => {
      g.clearRect(0, 0, w, h);
      draw(g);
      tex.needsUpdate = true;
    };
    paint();
    void document.fonts.ready.then(paint);
  }, [tex, ...deps]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Fit text on one line by shrinking the font.
export function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight: number, family = FONT_DISPLAY) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  while (g.measureText(text).width > maxW && s > 12) {
    s -= 2;
    g.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

// A small seeded noise so the same texture comes out every launch.
const noise = (seed: number) => {
  let s = seed;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};

let code: CanvasTexture | null = null;
export function codeTexture() {
  if (code) return code;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#fff';
  for (let row = 0; row < 12; row++) {
    const indent = ((row * 5) % 3) * 5;
    const len = 12 + ((row * 37) % 34);
    g.fillRect(4 + indent, 3 + row * 5, len, 2);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = NearestFilter;
  code = t;
  return t;
}

let ownerComputer: CanvasTexture | null = null;
export function ownerComputerTexture() {
  if (ownerComputer) return ownerComputer;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 288;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 0, 288);
  bg.addColorStop(0, '#173c68');
  bg.addColorStop(1, '#0b1a32');
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 288);
  g.fillStyle = 'rgba(108, 205, 255, 0.16)';
  g.fillRect(0, 0, 512, 42);
  g.fillStyle = '#8de4ff';
  g.font = `700 21px ${FONT_DISPLAY}`;
  g.fillText('ONLINE OFFICE', 24, 28);
  g.fillStyle = 'rgba(255,255,255,0.68)';
  g.font = `500 13px ${FONT_BODY}`;
  g.fillText('OWNER CONSOLE', 374, 27);
  const cards = [
    { x: 24, w: 142, value: '04', label: 'active teams', color: '#6fe0b0' },
    { x: 181, w: 142, value: '12', label: 'agents online', color: '#8dc7ff' },
    { x: 338, w: 150, value: '0', label: 'needs you', color: '#f7c766' },
  ];
  for (const card of cards) {
    g.fillStyle = 'rgba(255,255,255,0.09)';
    roundRect(g, card.x, 70, card.w, 88, 12);
    g.fill();
    g.fillStyle = card.color;
    g.font = `800 30px ${FONT_DISPLAY}`;
    g.fillText(card.value, card.x + 14, 108);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = `500 13px ${FONT_BODY}`;
    g.fillText(card.label, card.x + 14, 136);
  }
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(24, 194, 464, 1);
  g.fillStyle = '#b8d7f4';
  g.font = `600 14px ${FONT_BODY}`;
  g.fillText('Everything is running smoothly', 24, 226);
  g.fillStyle = '#6fe0b0';
  g.beginPath();
  g.arc(28, 252, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = `500 12px ${FONT_BODY}`;
  g.fillText('Last synced just now', 42, 256);
  ownerComputer = new CanvasTexture(c);
  ownerComputer.colorSpace = SRGBColorSpace;
  ownerComputer.anisotropy = 8;
  return ownerComputer;
}

const tile = (size: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: number) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  if (repeat) t.repeat.set(repeat, repeat);
  return t;
};

let grass: CanvasTexture | null = null;
export function grassTexture() {
  return (grass ??= tile(
    256,
    (g) => {
      const r = noise(7);
      g.fillStyle = '#74b24e';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 90; i++) {
        const x = r() * 256, y = r() * 256, rad = 14 + r() * 34;
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        grad.addColorStop(0, r() < 0.5 ? 'rgba(125,185,80,0.35)' : 'rgba(80,145,65,0.3)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
          g.beginPath(); g.arc(x + ox, y + oy, rad, 0, 6.3); g.fill();
        }
      }
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(50,115,45,0.22)' : 'rgba(160,210,110,0.22)';
        g.fillRect(r() * 256, r() * 256, 1.5, 3 + r() * 3);
      }
    },
    210,
  ));
}

let pavers: CanvasTexture | null = null;
export function paverTexture() {
  return (pavers ??= tile(256, (g) => {
    const r = noise(31);
    g.fillStyle = '#9b9486';
    g.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 4; row++) {
      let x = -((row * 37) % 64);
      while (x < 256) {
        const w = 48 + r() * 30;
        const l = 62 + r() * 12;
        g.fillStyle = `hsl(${34 + r() * 8}, ${8 + r() * 8}%, ${l}%)`;
        g.fillRect(x + 2, row * 64 + 2, w - 4, 60);
        x += w;
      }
    }
  }));
}

let sky: CanvasTexture | null = null;
export function skyTexture(horizon: string) {
  if (sky) return sky;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  // The sphere's v runs from the nadir (0) to the zenith (1): blue above the horizon (canvas top), peach haze at and below it.
  const grad = g.createLinearGradient(0, 0, 0, 512);
  // The first ten degrees above the horizon are what a window shows from the floor, so the blue arrives quickly.
  grad.addColorStop(0, '#2f68b8');
  grad.addColorStop(0.28, '#4a86d0');
  grad.addColorStop(0.45, '#6aa0e0');
  grad.addColorStop(0.472, '#9cc4ee');
  grad.addColorStop(0.489, '#cfe0ee');
  grad.addColorStop(0.5, '#f6dcb6');
  grad.addColorStop(0.53, horizon);
  grad.addColorStop(1, horizon);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 512);
  const r = noise(5);
  for (let i = 0; i < 26; i++) {
    const x = r() * 1024, y = 150 + r() * 80, w = 60 + r() * 110;
    for (let k = 0; k < 6; k++) {
      const px = x + (r() - 0.5) * w, py = y + (r() - 0.5) * 16, rad = 18 + r() * 26;
      const cg = g.createRadialGradient(px, py, 0, px, py, rad);
      cg.addColorStop(0, 'rgba(255,233,208,0.8)');
      cg.addColorStop(1, 'rgba(255,233,208,0)');
      g.fillStyle = cg;
      for (const ox of [-1024, 0, 1024]) { g.beginPath(); g.arc(px + ox, py, rad, 0, 6.3); g.fill(); }
    }
  }
  sky = new CanvasTexture(c);
  sky.colorSpace = SRGBColorSpace;
  return sky;
}

let blob: CanvasTexture | null = null;
export function blobShadowTexture() {
  if (blob) return blob;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blob = new CanvasTexture(c);
  return blob;
}

let ceiling: CanvasTexture | null = null;
export function ceilingTexture() {
  return (ceiling ??= tile(128, (g) => {
    const r = noise(11);
    g.fillStyle = '#f3f0ea';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(120,110,95,0.10)' : 'rgba(255,255,255,0.35)';
      g.fillRect(r() * 128, r() * 128, 1.5, 1.5);
    }
    g.fillStyle = 'rgba(110,100,85,0.45)';
    g.fillRect(0, 0, 128, 3);
    g.fillRect(0, 0, 3, 128);
  }));
}

let pool: CanvasTexture | null = null;
/** A soft round glow, white at the middle and clear at the rim. Tinted per instance, it becomes a pool of lamplight on the floor. */
export function poolTexture() {
  if (pool) return pool;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  pool = new CanvasTexture(c);
  return pool;
}

let wallAo: CanvasTexture | null = null;
/** Dark along the middle line of a wall's footprint, fading to nothing on both sides: the shade where a wall meets the floor. */
export function wallAoTexture() {
  if (wallAo) return wallAo;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.42, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.6)');
  grad.addColorStop(0.58, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 64);
  wallAo = new CanvasTexture(c);
  return wallAo;
}
