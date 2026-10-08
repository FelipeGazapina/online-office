// How far apart the before-* and after-* pictures of shots-textures.mjs are, per framing: PSNR and SSIM from ImageMagick, and the
// share of pixels that moved by more than `--tol` (default 6 of 255 per channel), which is what an eye could pick out.
// Run: node verify/texture-diff.mjs <shots dir> [--tol 6]   Needs `magick` (brew install imagemagick). Writes the 8x difference of each pair to <shots dir>/diff/<name>.png.
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
console.log(`${'framing'.padEnd(18)}${'PSNR dB'.padStart(9)}${'SSIM'.padStart(9)}${`> ${tol}/255`.padStart(10)}${'max'.padStart(6)}`);
for (const name of names) {
  const a = join(dir, `before-${name}.png`);
  const b = join(dir, `after-${name}.png`);
  if (!existsSync(b)) {
    console.log(`${name.padEnd(18)}  (no after shot)`);
    continue;
  }
  // ImageMagick 7 prints the metric and, in brackets, the same figure on a 0 to 1 scale; for SSIM that is the dissimilarity (1 - SSIM).
  const psnr = (Number.parseFloat(run('compare', '-metric', 'PSNR', a, b, 'null:').stderr) || Infinity).toFixed(2);
  const ssim = (1 - Number(/\(([\d.e+-]+)\)/.exec(run('compare', '-metric', 'SSIM', a, b, 'null:').stderr)?.[1])).toFixed(5);
  // Absolute difference, then the share of pixels where any channel is over the tolerance, and the largest single step.
  const diff = join(dir, 'diff', `${name}.png`);
  run(a, b, '-compose', 'difference', '-composite', '-evaluate', 'multiply', '8', diff);
  const over = Number(run(a, b, '-compose', 'difference', '-composite', '-channel', 'RGB', '-separate', '-evaluate-sequence', 'max', '-threshold', `${(tol / 255) * 100}%`, '-format', '%[fx:mean]', 'info:').stdout) * 100;
  const max = Number(run(a, b, '-compose', 'difference', '-composite', '-format', '%[fx:maxima*255]', 'info:').stdout);
  console.log(`${name.padEnd(18)}${psnr.padStart(9)}${ssim.padStart(9)}${`${over.toFixed(3)}%`.padStart(10)}${max.toFixed(0).padStart(6)}`);
}
