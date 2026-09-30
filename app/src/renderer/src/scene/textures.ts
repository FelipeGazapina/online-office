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

let plank: CanvasTexture | null = null;
export function plankTexture() {
  if (plank) return plank;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const rows = 8;
  const rh = 512 / rows;
  for (let r = 0; r < rows; r++) {
    // Staggered seams, each plank a slightly different honey tone.
    let x = -((r * 173) % 256);
    while (x < 512) {
      const len = 200 + ((x * 7 + r * 31) % 160);
      const l = 62 + ((x * 13 + r * 17) % 9);
      g.fillStyle = `hsl(${30 + ((x + r * 11) % 5)}, ${46 + ((r * 7) % 8)}%, ${l}%)`;
      g.fillRect(x, r * rh, len, rh);
      g.fillStyle = 'rgba(90,55,25,0.22)';
      g.fillRect(x, r * rh, 2, rh);
      x += len;
    }
    g.fillStyle = 'rgba(90,55,25,0.28)';
    g.fillRect(0, r * rh, 512, 2);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  plank = t;
  return t;
}

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
