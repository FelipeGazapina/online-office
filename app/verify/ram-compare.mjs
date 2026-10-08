// Puts the result.json files of e2e-ram runs side by side: the peak, the split at the peak, each class's peak and mean over the second
// half of the window, the slope, the working count and the frames. Use it for the variance between two runs of one build, or the
// difference between a base build and a change.
//   node verify/ram-compare.mjs <a/result.json> <b/result.json> [...]
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const files = process.argv.slice(2);
if (files.length < 2) throw new Error('usage: node verify/ram-compare.mjs <result.json> <result.json> [...]');
const runs = files.map((f) => ({ name: basename(dirname(f)), r: JSON.parse(readFileSync(f, 'utf8')) }));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-');

const rows = [];
const add = (label, get) => rows.push([label, ...runs.map(({ r }) => get(r))]);
const second = (r, pick) => mean(r.samples.filter((s) => !s.error && s.tSec / 60 >= r.meta.minutes / 2).map(pick));
add('mode / sha', (r) => `${r.meta.mode} ${r.meta.sha}`);
add('valid', (r) => (r.valid ? 'yes' : 'NO'));
add('peak MiB (counted)', (r) => f1(r.summary.peakMiB));
add('  at minute', (r) => f1(r.summary.peakAtMin));
add('ramp ends at min / peak after it', (r) => `${r.working.rampMin ?? '-'} / ${f1(r.summary.peakAfterRampMiB)}`);
for (const c of ['main', 'renderer', 'gpu', 'utility', 'other', 'ackers']) add(`  ${c} at peak`, (r) => f1(r.summary.atPeak[c]));
add('agents at peak (not counted)', (r) => f1(r.summary.atPeak.agents));
for (const c of ['main', 'renderer', 'gpu', 'utility', 'other', 'ackers', 'agents']) add(`class peak ${c}`, (r) => f1(r.summary.classPeak[c]));
add('counted, mean of 2nd half', (r) => f1(second(r, (s) => s.countedMiB)));
for (const c of ['main', 'renderer', 'gpu', 'other', 'ackers']) add(`  ${c}, mean of 2nd half`, (r) => f1(second(r, (s) => s.classes[c])));
add('slope MiB/min (2nd half)', (r) => f1(r.summary.slopeMiBPerMin));
add('working mean after ramp', (r) => String(r.working.meanAfterRamp ?? r.working.meanAfterTwoMinutes ?? r.working.mean));
add('fps / slow %', (r) => (r.frames ? `${r.frames.fpsAvg} / ${r.frames.slowPct}` : '-'));
add('max swap MiB / pressure', (r) => `${f1(r.summary.maxSwapUsedMiB)} / ${r.summary.maxPressureLevel}`);

const width = Math.max(...rows.map((r) => r[0].length)) + 2;
console.log(['', ...runs.map((x) => x.name)].map((c, i) => (i ? c.padStart(22) : c.padEnd(width))).join(''));
for (const [label, ...cells] of rows) console.log(label.padEnd(width) + cells.map((c) => String(c).padStart(22)).join(''));
if (runs.length === 2) {
  const [a, b] = runs.map(({ r }) => r);
  const d = (x, y) => `${(y - x >= 0 ? '+' : '') + (y - x).toFixed(1)} (${(((y - x) / x) * 100).toFixed(1)}%)`;
  console.log(`\npeak ${d(a.summary.peakMiB, b.summary.peakMiB)}; 2nd-half mean ${d(second(a, (s) => s.countedMiB), second(b, (s) => s.countedMiB))}`);
}
