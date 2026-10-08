// Writes the bundled prop and surface maps at the size the closest camera can use (see app/verify/texture-budget.ts for the table
// of what each map costs). The full-size maps stay in git history; the bundle ships the shrunk ones.
//   mkdir /tmp/props && cd /tmp/props && npm i sharp
//   git -C <repo> archive <commit before the shrink> app/src/renderer/src/assets/models app/src/renderer/src/assets/textures | tar -x -C /tmp/orig
//   node shrink-textures.mjs <originals assets dir> <assets dir to write>
// Each map is resampled from the original (never from an earlier shrink), so the result does not depend on how often it ran.
import sharp from 'sharp';
import { readdirSync, statSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Scale per axis of each map. A key is matched against the file path under assets/ (models/sofa-diff.jpg, textures/wood/nor.jpg),
// the first match wins, and a file nothing matches keeps its size.
//   Colour maps stay as sharp as the closest camera needs. Normal and ARM maps (ambient occlusion in red, roughness in green) hold
//   slow gradients plus fine relief that lighting only shows at a grazing angle, so a half-size map costs a quarter of the bytes
//   and is not told apart at the closest view.
export const SCALES = [
  [/^models\/(desk_clock|vase|picture_frame|desk_lamp|laptop|plant_succulent)-/, 0.5],
  [/[-/](nor|arm)\.jpg$/, 0.5],
];

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.jpg') ? [path] : [];
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  const [from, to] = process.argv.slice(2);
  for (const source of files(from)) {
    const rel = relative(from, source);
    const scale = SCALES.find(([pattern]) => pattern.test(rel))?.[1] ?? 1;
    const { width, height } = await sharp(source).metadata();
    const w = Math.max(16, Math.round(width * scale));
    const h = Math.max(16, Math.round(height * scale));
    if (scale === 1) {
      await copyFile(source, join(to, rel));
      console.log(rel.padEnd(36), `${width}x${height} kept`);
      continue;
    }
    // 4:4:4 keeps a normal map's colour channels as sharp as its luma.
    const out = await sharp(source).resize(w, h, { kernel: 'lanczos3' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    await writeFile(join(to, rel), out);
    console.log(rel.padEnd(36), `${width}x${height} -> ${w}x${h}`, `${out.length} bytes`);
  }
}
