// How far apart the before-* and after-* pictures of shots-textures.mjs are, per framing: PSNR and SSIM from ImageMagick, and the
// share of pixels that moved by more than `--tol` (default 6 of 255 per channel), which is what an eye could pick out.
// The clock at the top left of the HUD counts the minutes between two runs, so a box over it is painted out of both pictures first.
// Run: node verify/texture-diff.mjs <shots dir> [--tol 6]   Needs `magick` (brew install imagemagick).
// Writes the masked pair and a picture of the pixels beyond the tolerance (in red) to <shots dir>/diff/<name>.png.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--tol');
const tol = args.includes('--tol') ? Number(args[args.indexOf('--tol') + 1]) : 6;
if (!dir) throw new Error('usage: node verify/texture-diff.mjs <shots dir> [--tol 6]');

mkdirSync(join(dir, 'diff'), { recursive: true });
const run = (...a) => spawnSync('magick', a, { encoding: 'utf8' });
const names = readdirSync(dir).filter((f) => f.startsWith('before-') && f.endsWith('.png')).map((f) => f.slice('before-'.length, -'.png'.length)).sort();
console.log(`${'framing'.padEnd(18)}${'PSNR dB'.padStart(9)}${'SSIM'.padStart(9)}${`> ${tol}/255`.padStart(10)}`);
for (const name of names) {
  const b = join(dir, `after-${name}.png`);
  if (!existsSync(b)) {
    console.log(`${name.padEnd(18)}  (no after shot)`);
    continue;
  }
  const masked = ['before', 'after'].map((phase) => {
    const out = join(dir, 'diff', `${phase}-${name}.png`);
    run(join(dir, `${phase}-${name}.png`), '-fill', 'black', '-draw', 'rectangle 0,0 170,70', '-depth', '8', out);
    return out;
  });
  const [a, c] = masked;
  // ImageMagick 7 prints the metric and, in brackets, the same figure on a 0 to 1 scale; for SSIM that is the dissimilarity (1 - SSIM).
  const psnr = (Number.parseFloat(run('compare', '-metric', 'PSNR', a, c, 'null:').stderr) || Infinity).toFixed(2);
  const ssim = (1 - Number(/\(([\d.e+-]+)\)/.exec(run('compare', '-metric', 'SSIM', a, c, 'null:').stderr)?.[1])).toFixed(5);
  const [w, h] = run('identify', '-format', '%w %h', a).stdout.split(' ').map(Number);
  const moved = Number.parseFloat(run('compare', '-metric', 'AE', '-fuzz', `${((tol / 255) * 100).toFixed(2)}%`, '-highlight-color', 'red', '-lowlight-color', 'none', a, c, join(dir, 'diff', `${name}.png`)).stderr);
  console.log(`${name.padEnd(18)}${psnr.padStart(9)}${ssim.padStart(9)}${`${((moved / (w * h)) * 100).toFixed(3)}%`.padStart(10)}`);
}
