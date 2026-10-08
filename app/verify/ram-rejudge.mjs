// Reads an e2e-ram result.json again and re-derives what depends on the judging rules (the end of the ramp, the peak after it, the
// working average after it, the verdict) from the recorded samples, then writes the file back. The memory figures are never touched.
//   node verify/ram-rejudge.mjs <run/result.json> [...]
import { readFileSync, writeFileSync } from 'node:fs';

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (n) => +n.toFixed(1);
const PEOPLE = 15;

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const ok = r.samples.filter((s) => !s.error);
  const rampAt = ok.find((s) => (s.people?.working ?? 0) >= PEOPLE - 1);
  const ramp = rampAt ? rampAt.tSec / 60 : null;
  const steady = ok.filter((s) => ramp !== null && s.tSec / 60 >= ramp).map((s) => s.people?.working ?? 0);
  const after = ok.filter((s) => s.tSec / 60 >= (ramp ?? 2));
  r.summary.peakAfterRampMiB = after.length ? Math.max(...after.map((s) => s.countedMiB)) : null;
  delete r.working.meanAfterTwoMinutes;
  r.working.rampMin = ramp === null ? null : +ramp.toFixed(2);
  r.working.meanAfterRamp = steady.length ? r1(mean(steady)) : null;
  const reasons = [];
  const overlap = [...new Map(ok.flatMap((x) => x.others ?? []).map((o) => [o.pid, o])).values()];
  if (overlap.length) reasons.push(`another Online Office app was running: ${overlap.map((o) => `pid ${o.pid} ${o.command}`).join('; ')}`);
  if (ramp === null) reasons.push(`never ${PEOPLE - 1} people working at once`);
  else if (ramp > r.meta.minutes * 0.5) reasons.push(`the ramp took ${ramp.toFixed(1)} min of ${r.meta.minutes}`);
  else if (steady.length && mean(steady) < PEOPLE - 0.5) reasons.push(`only ${mean(steady).toFixed(1)} of ${PEOPLE} people were working on average after the ramp`);
  if (!ok.length || ok.length < r.meta.minutes * 5) reasons.push(`only ${ok.length} samples`);
  r.valid = reasons.length === 0;
  r.invalidReasons = reasons;
  writeFileSync(file, JSON.stringify(r, null, 1));
  console.log(`${file}: ramp ${r.working.rampMin} min, working after it ${r.working.meanAfterRamp}, peak after it ${r.summary.peakAfterRampMiB}, ${r.valid ? 'valid' : `INVALID: ${reasons.join(' | ')}`}`);
}
