// Paint swatches drawn as the material they paint, not a flat chip: one small tiling SVG per material over the paint's own color.
import { FLOOR_PAINTS, WALL_STYLES } from '../../../../shared/space/index.ts';

const DARK = 'rgba(30,20,10,0.26)';
const LIGHT = 'rgba(255,255,255,0.3)';

const dots = (step: number, r: number, fill: string, shift = 0) =>
  `<pattern id="p" width="${step}" height="${step}" patternUnits="userSpaceOnUse"><circle cx="${step / 2 + shift}" cy="${step / 2}" r="${r}" fill="${fill}"/></pattern><rect width="64" height="64" fill="url(#p)"/>`;

const PATTERNS: Readonly<Record<string, string>> = {
  wood:
    [0, 16, 32, 48].map((y, i) => `<rect y="${y}" width="64" height="1.5" fill="${DARK}"/><rect x="${i % 2 ? 40 : 18}" y="${y}" width="1.5" height="16" fill="${DARK}"/><path d="M0 ${y + 6}h64M0 ${y + 11}h64" stroke="${LIGHT}" stroke-width=".7" stroke-dasharray="${9 + i * 3} 6"/>`).join(''),
  carpet: dots(4, 0.9, 'rgba(255,255,255,0.26)') + dots(4, 0.8, 'rgba(0,0,0,0.2)', 2),
  tile: `<path d="M0 0H64V64H0z" fill="none"/><path d="M0 .5H64M0 32H64M.5 0V64M32 0V64" stroke="${DARK}" stroke-width="1.6"/><path d="M0 0L64 64" stroke="rgba(255,255,255,0.16)" stroke-width="10"/>`,
  concrete: [[8, 10, 1.4], [22, 40, 1], [40, 18, 1.6], [52, 50, 1.2], [14, 56, 1.1], [58, 8, 1], [34, 30, 0.9], [46, 38, 1.3]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${DARK}"/>`).join('') + `<ellipse cx="30" cy="22" rx="20" ry="9" fill="rgba(255,255,255,0.14)"/>`,
  plaster: dots(6, 0.7, 'rgba(120,90,50,0.22)') + `<path d="M0 0H64" stroke="rgba(255,255,255,0.35)" stroke-width="6"/>`,
  brick: [0, 1, 2, 3, 4, 5].map((i) => `<rect y="${i * 10.5}" width="64" height="1.6" fill="rgba(238,226,208,0.7)"/><rect x="${i % 2 ? 10 : 32}" y="${i * 10.5}" width="1.8" height="10.5" fill="rgba(238,226,208,0.7)"/><rect x="${i % 2 ? 42 : 0}" y="${i * 10.5}" width="1.8" height="10.5" fill="rgba(238,226,208,0.7)"/>`).join(''),
  panel: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="${i * 8}" width="1.5" height="64" fill="rgba(25,15,5,0.4)"/><path d="M${i * 8 + 4} 0v64" stroke="${LIGHT}" stroke-width=".7" stroke-dasharray="${12 + i * 2} 7"/>`).join(''),
  paint: `<rect width="64" height="64" fill="rgba(255,255,255,0.0)"/><path d="M0 8H64" stroke="rgba(120,110,95,0.12)" stroke-width="10"/>` + dots(8, 0.5, 'rgba(120,110,95,0.2)'),
};

const MATERIAL_OF = (name: string): string =>
  name.startsWith('wood_panel') ? 'panel' : name.startsWith('wood') ? 'wood' : name.startsWith('carpet') ? 'carpet' : name.startsWith('tile') ? 'tile' : name === 'white' ? 'paint' : name;

const url = (pattern: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${pattern}</svg>`)}")`;

export type SwatchStyle = { backgroundColor: string; backgroundImage?: string; backgroundSize?: string };

export function floorSwatch(paint: number): SwatchStyle {
  const p = FLOOR_PAINTS[paint];
  const pattern = paint === 0 ? undefined : PATTERNS[MATERIAL_OF(p.name)];
  return pattern ? { backgroundColor: p.color, backgroundImage: url(pattern), backgroundSize: '100% 100%' } : { backgroundColor: p.color };
}

export function wallSwatch(style: number): SwatchStyle {
  const s = WALL_STYLES[style];
  const pattern = PATTERNS[MATERIAL_OF(s.name)];
  return pattern ? { backgroundColor: s.color, backgroundImage: url(pattern), backgroundSize: '100% 100%' } : { backgroundColor: s.color };
}
