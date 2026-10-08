// No app, no model. Lists every texture source the renderer holds, with the bytes its decoded pixels take and the bytes its GPU copy
// takes (RGBA8, with a full mip chain unless the texture has none), and fails above the budget set at the bottom.
// Run from app/: node verify/texture-budget.ts   Exits 1 on any failed check.
//
// Two kinds of source:
//   - Files: every .jpg under assets/models and assets/textures, read from disk, so a bigger map or a new one moves the total.
//   - Canvases: drawn in code. Each creation site in scene/** has a row in CANVASES with its size and how many the reference
//     office makes; a site with no row fails, so a new canvas cannot slip in unpriced.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check, finish } from './check.ts';

const SRC = new URL('../src/renderer/src/', import.meta.url).pathname;
const MiB = 1024 * 1024;
const mib = (bytes: number) => (bytes / MiB).toFixed(2).padStart(7);

/** The office the RAM bar names: 3 floors, 15 employees. Teams hold one whiteboard, one sign and one daily sign each. */
const OFFICE = { blocks: 5, desks: 15, facilitySigns: 5 };

type Source = { name: string; kind: 'file' | 'canvas'; count: number; w: number; h: number; gpuEach: number; decodedEach: number; keptEach: number };

/** Bytes of a W x H RGBA8 texture and of the mip chain below it. */
function rgba8(w: number, h: number, mips: boolean) {
  let bytes = 0;
  for (;;) {
    bytes += w * h * 4;
    if (!mips || (w === 1 && h === 1)) return bytes;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

/** Width and height from the first start-of-frame marker of a JPEG. */
function jpegSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`${file}: bad marker at ${i}`);
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error(`${file}: no frame header`);
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

// A bitmap texture closes its decoded image once three has uploaded it (bitmapTexture.ts), so a file keeps nothing in the renderer.
const bitmapText = readFileSync(join(SRC, 'scene/bitmapTexture.ts'), 'utf8');
const closesBitmap = /onUpdate\s*=/.test(bitmapText) && /\.close\(\)/.test(bitmapText);

const sources: Source[] = [];
const files = ['assets/models', 'assets/textures'].flatMap((d) => walk(join(SRC, d))).filter((f) => f.endsWith('.jpg'));
for (const f of files) {
  const { w, h } = jpegSize(f);
  sources.push({ name: relative(join(SRC, 'assets'), f), kind: 'file', count: 1, w, h, gpuEach: rgba8(w, h, true), decodedEach: rgba8(w, h, false), keptEach: closesBitmap ? 0 : rgba8(w, h, false) });
}

type Canvas = { file: string; sites: number; name: string; w: number; h: number; count: number; mips?: boolean; kept?: boolean };
// `count` is how many the reference office holds at once. `mips: false` is a texture with no mip chain; `kept: false` is a canvas whose
// pixels are released after the upload (the 2D backing store is gone; the GPU copy stays), which every useCanvasTexture caller does.
const CANVASES: Canvas[] = [
  { file: 'scene/textures.ts', sites: 1, name: 'useCanvasTexture (the sizes of its callers are below)', w: 0, h: 0, count: 0 },
  { file: 'scene/textures.ts', sites: 1, name: 'monitor code screen', w: 64, h: 64, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'owner console screen', w: 512, h: 288, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'grass and pavers (tile 256)', w: 256, h: 256, count: 2 },
  { file: 'scene/textures.ts', sites: 0, name: 'ceiling (tile 128)', w: 128, h: 128, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'exterior sky', w: 1024, h: 512, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'blob shadow', w: 64, h: 64, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'lamp pool', w: 128, h: 128, count: 1 },
  { file: 'scene/textures.ts', sites: 1, name: 'wall contact shade', w: 8, h: 64, count: 1 },
  { file: 'scene/LobbyMaterials.tsx', sites: 1, name: 'lobby brick', w: 1024, h: 512, count: 1, kept: false },
  { file: 'scene/LobbyMaterials.tsx', sites: 1, name: 'lobby terrazzo', w: 1024, h: 512, count: 1, kept: false },
  { file: 'scene/LobbyMaterials.tsx', sites: 1, name: 'lobby rug', w: 1024, h: 640, count: 1, kept: false },
  { file: 'scene/Exterior.tsx', sites: 1, name: 'exterior road lines', w: 1024, h: 512, count: 1, kept: false },
  { file: 'scene/LobbyVoid.tsx', sites: 1, name: 'lobby void sky', w: 64, h: 256, count: 1 },
  { file: 'scene/people/faces.ts', sites: 1, name: 'face atlas (6 cells of 256)', w: 1536, h: 256, count: 1 },
  { file: 'scene/building/shadows.ts', sites: 1, name: 'shadow atlas', w: 1024, h: 1024, count: 1, mips: false },
  { file: 'scene/BlockView.tsx', sites: 1, name: 'team sign', w: 1024, h: 320, count: OFFICE.blocks, kept: false },
  { file: 'scene/BlockView.tsx', sites: 1, name: 'daily sign', w: 420, h: 180, count: OFFICE.blocks, kept: false },
  // A team shows exactly one of these four boards, so they are one row; the largest of them sets the size.
  { file: 'scene/BlockView.tsx', sites: 3, name: 'team whiteboard (diagram / GitHub / Linear)', w: 1536, h: 840, count: OFFICE.blocks, kept: false },
  { file: 'scene/TaskBoardWall.tsx', sites: 1, name: 'team task board wall', w: 1536, h: 840, count: 0, kept: false },
  { file: 'scene/Office.tsx', sites: 1, name: 'expand site dirt', w: 512, h: 400, count: 1, kept: false },
  { file: 'scene/Office.tsx', sites: 1, name: 'expand site board', w: 512, h: 200, count: 1, kept: false },
  { file: 'scene/Office.tsx', sites: 1, name: 'facility floor sign', w: 900, h: 220, count: OFFICE.facilitySigns, kept: false },
  { file: 'scene/Office.tsx', sites: 1, name: 'company sign', w: 1024, h: 256, count: 1, kept: false },
  { file: 'scene/Furniture.tsx', sites: 1, name: 'desk nameplate', w: 256, h: 96, count: OFFICE.desks, kept: false },
  // The terminal atlas is priced by its own unit; its sites are listed so the scan stays exact.
  { file: 'scene/terminalAtlas.ts', sites: 2, name: 'terminal atlas (not counted here)', w: 0, h: 0, count: 0 },
];
for (const c of CANVASES) {
  if (!c.count) continue;
  sources.push({ name: c.name, kind: 'canvas', count: c.count, w: c.w, h: c.h, gpuEach: rgba8(c.w, c.h, c.mips !== false), decodedEach: rgba8(c.w, c.h, false), keptEach: c.kept === false ? 0 : rgba8(c.w, c.h, false) });
}

// Every place scene/** makes a texture from pixels must have a row above.
const found = new Map<string, number>();
for (const f of walk(join(SRC, 'scene')).filter((p) => /\.tsx?$/.test(p))) {
  const text = readFileSync(f, 'utf8');
  const n = (text.match(/useCanvasTexture\((?!w: number)|new CanvasTexture\(|new Texture\(canvas|new DataTexture\(/g) ?? []).length;
  if (n) found.set(relative(SRC, f), n);
}
const priced = new Map<string, number>();
for (const c of CANVASES) priced.set(c.file, (priced.get(c.file) ?? 0) + c.sites);
for (const file of new Set([...found.keys(), ...priced.keys()])) {
  check((found.get(file) ?? 0) === (priced.get(file) ?? 0), `${file}: ${found.get(file) ?? 0} texture site(s) in the code, ${priced.get(file) ?? 0} priced here`, 'add or remove the row in CANVASES');
}

const totals = (kind?: Source['kind']) =>
  sources.filter((s) => !kind || s.kind === kind).reduce((a, s) => ({ gpu: a.gpu + s.gpuEach * s.count, decoded: a.decoded + s.decodedEach * s.count, kept: a.kept + s.keptEach * s.count, px: a.px + s.w * s.h * s.count }), { gpu: 0, decoded: 0, kept: 0, px: 0 });

console.log(`\n${'source'.padEnd(46)}${'size'.padStart(11)}${'x'.padStart(4)}${'decoded MiB'.padStart(13)}${'GPU MiB'.padStart(10)}${'kept MiB'.padStart(10)}`);
for (const s of [...sources].sort((a, b) => b.gpuEach * b.count - a.gpuEach * a.count)) {
  console.log(`${s.name.padEnd(46)}${`${s.w}x${s.h}`.padStart(11)}${String(s.count).padStart(4)}${mib(s.decodedEach * s.count).padStart(13)}${mib(s.gpuEach * s.count).padStart(10)}${mib(s.keptEach * s.count).padStart(10)}`);
}
const file = totals('file');
const canvas = totals('canvas');
const all = totals();
console.log(`\n${'files'.padEnd(46)}${''.padStart(15)}${mib(file.decoded).padStart(13)}${mib(file.gpu).padStart(10)}${mib(file.kept).padStart(10)}   (${(file.px / 1e6).toFixed(1)} MP in ${files.length} files)`);
console.log(`${'canvases'.padEnd(46)}${''.padStart(15)}${mib(canvas.decoded).padStart(13)}${mib(canvas.gpu).padStart(10)}${mib(canvas.kept).padStart(10)}`);
console.log(`${'total'.padEnd(46)}${''.padStart(15)}${mib(all.decoded).padStart(13)}${mib(all.gpu).padStart(10)}${mib(all.kept).padStart(10)}\n`);

// The budget, a few percent over what the maps and canvases cost now. Base game/office at 73e7210 had 232 MiB of file textures on the GPU, kept
// the 174 MiB they decode to in the renderer, and kept 57 MiB of canvas pixels next to the GPU copy of the canvases.
const BUDGET = { fileGpu: 110, canvasGpu: 78, kept: 10 };
check(closesBitmap, 'bitmap textures close their decoded image after the upload');
check(file.gpu <= BUDGET.fileGpu * MiB, `file textures on the GPU ${mib(file.gpu).trim()} MiB <= ${BUDGET.fileGpu} MiB`);
check(canvas.gpu <= BUDGET.canvasGpu * MiB, `canvas textures on the GPU ${mib(canvas.gpu).trim()} MiB <= ${BUDGET.canvasGpu} MiB`);
check(all.kept <= BUDGET.kept * MiB, `pixels kept in the renderer next to the GPU copy ${mib(all.kept).trim()} MiB <= ${BUDGET.kept} MiB`);
finish();
