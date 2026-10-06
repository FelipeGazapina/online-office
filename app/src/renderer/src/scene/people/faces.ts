import { CanvasTexture, SRGBColorSpace } from 'three';
import { FACES } from './appearance.ts';

export const FACE_CELL = 256;
const FEATURE_SCALE = 1.6;

const INK = '#2b1d1a';

type Eyes = 'dot' | 'oval' | 'happy' | 'wide';
type Mouth = 'smile' | 'grin' | 'flat' | 'smirk' | 'open' | 'soft';
type Brow = { tilt: number; lift: number; thick: number };
const SPEC: { eyes: Eyes; mouth: Mouth; brow: Brow }[] = [
  { eyes: 'oval', mouth: 'smile', brow: { tilt: 0.0, lift: 0, thick: 5 } },
  { eyes: 'dot', mouth: 'flat', brow: { tilt: 0.12, lift: 0, thick: 6 } },
  { eyes: 'happy', mouth: 'grin', brow: { tilt: -0.1, lift: 4, thick: 5 } },
  { eyes: 'wide', mouth: 'soft', brow: { tilt: -0.05, lift: 6, thick: 4 } },
  { eyes: 'oval', mouth: 'smirk', brow: { tilt: 0.08, lift: 0, thick: 6 } },
  { eyes: 'dot', mouth: 'open', brow: { tilt: -0.14, lift: 6, thick: 5 } },
];

function eye(g: CanvasRenderingContext2D, x: number, y: number, kind: Eyes) {
  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.lineCap = 'round';
  if (kind === 'happy') {
    g.lineWidth = 7;
    g.beginPath();
    g.arc(x, y + 6, 13, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
    return;
  }
  const rx = kind === 'dot' ? 8 : kind === 'wide' ? 12 : 9;
  const ry = kind === 'dot' ? 9 : kind === 'wide' ? 15 : 13;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(x + rx * 0.3, y - ry * 0.35, rx * 0.34, 0, Math.PI * 2);
  g.fill();
}

function mouth(g: CanvasRenderingContext2D, x: number, y: number, kind: Mouth) {
  g.strokeStyle = INK;
  g.fillStyle = '#7a2e2e';
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  if (kind === 'smile') g.arc(x, y - 14, 24, Math.PI * 0.2, Math.PI * 0.8);
  else if (kind === 'soft') g.arc(x, y - 6, 15, Math.PI * 0.25, Math.PI * 0.75);
  else if (kind === 'flat') { g.moveTo(x - 17, y + 4); g.lineTo(x + 17, y + 4); }
  else if (kind === 'smirk') { g.moveTo(x - 16, y + 6); g.quadraticCurveTo(x + 6, y + 10, x + 22, y - 6); }
  else if (kind === 'grin') {
    g.arc(x, y - 18, 28, Math.PI * 0.12, Math.PI * 0.88);
    g.closePath();
    g.fillStyle = '#fff6ee';
    g.fill();
  } else { g.ellipse(x, y + 6, 11, 14, 0, 0, Math.PI * 2); g.fill(); return; }
  g.stroke();
}

let atlas: CanvasTexture | null = null;
// A row of face cells, white where bare skin shows, so the head's per-person skin colour tints it. Cell i is the face for appearance.face = i.
export function faceAtlas() {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = FACE_CELL * FACES;
  c.height = FACE_CELL;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  SPEC.forEach((f, i) => {
    g.save();
    g.translate(i * FACE_CELL + FACE_CELL / 2, FACE_CELL / 2);
    g.scale(FEATURE_SCALE, FEATURE_SCALE);
    for (const s of [-1, 1]) {
      g.fillStyle = 'rgba(255,120,110,0.24)';
      g.beginPath();
      g.ellipse(s * 58, 24, 18, 11, 0, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.translate(s * 40, -36 - f.brow.lift);
      g.rotate(f.brow.tilt * -s);
      g.fillStyle = 'rgba(55,35,28,0.85)';
      g.beginPath();
      g.roundRect(-20, -f.brow.thick / 2, 40, f.brow.thick, f.brow.thick / 2);
      g.fill();
      g.restore();
      eye(g, s * 40, -7, f.eyes);
    }
    mouth(g, 0, 44, f.mouth);
    g.restore();
  });
  atlas = new CanvasTexture(c);
  atlas.colorSpace = SRGBColorSpace;
  atlas.anisotropy = 8;
  return atlas;
}
