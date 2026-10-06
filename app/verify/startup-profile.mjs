// CPU profile of the built office's first seconds, attached before the page starts, with each busy stretch named by its top frames.
// Run from app/: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/startup-profile.mjs
// OFFICE_STALLS_FIXTURE=default|floors3, OFFICE_STALLS_VISIBLE=1, OFFICE_STALLS_DATA_DIR=<dir> as in e2e-startup-stalls.mjs.
// OFFICE_PROFILE_OUT=<file>   where the .cpuprofile goes (default /tmp/office-shots/startup.cpuprofile).
// OFFICE_PROFILE_MIN_MS=50    the shortest stretch to report.
// OFFICE_PROFILE_TOP=16       how many frames to list per stretch.
// node verify/startup-profile.mjs --analyze <file.cpuprofile>   reports a profile that was already taken.
// The page is held at its first instruction by Target.setAutoAttach, so the profile covers the whole load. A busy stretch is
// a run of samples with no idle gap over 5 ms; the page's own long-task list is printed beside it to match them by order.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname } from 'node:path';
import { launchHeld, RECORD_LONG_TASKS } from './startup-launch.mjs';

const minMs = Number(process.env.OFFICE_PROFILE_MIN_MS ?? 50);
const topN = Number(process.env.OFFICE_PROFILE_TOP ?? 16);

export function report(profile, stalls = []) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
  };
  let t = profile.startTime;
  const at = profile.samples.map((_, i) => (t += profile.timeDeltas[i]));
  const rel = (x) => (x - profile.startTime) / 1000;
  const stretches = [];
  let cur = null;
  for (let i = 0; i < profile.samples.length; i++) {
    if (byId.get(profile.samples[i]).callFrame.functionName === '(idle)') {
      if (cur && rel(at[i]) - cur.end > 5) stretches.push(cur), (cur = null);
      continue;
    }
    cur ??= { start: rel(at[i - 1] ?? at[i]), end: 0, idx: [] };
    cur.end = rel(at[i]);
    cur.idx.push(i);
  }
  if (cur) stretches.push(cur);
  console.log(`long tasks the page saw (start+duration ms): ${stalls.map(([s, d]) => `${s}+${d}`).join(' ') || 'none'}`);
  for (const s of stretches.filter((x) => x.end - x.start >= minMs)) {
    const self = new Map();
    const incl = new Map();
    for (const i of s.idx) {
      const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000;
      let id = profile.samples[i];
      const l0 = label(byId.get(id));
      self.set(l0, (self.get(l0) ?? 0) + dt);
      const seen = new Set();
      for (; id !== undefined; id = parent.get(id)) {
        const l = label(byId.get(id));
        if (!seen.has(l)) incl.set(l, (incl.get(l) ?? 0) + dt), seen.add(l);
      }
    }
    const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, v]) => `    ${v.toFixed(0).padStart(5)} ms  ${l}`).join('\n');
    console.log(`\nbusy ${s.start.toFixed(0)}..${s.end.toFixed(0)} ms (${(s.end - s.start).toFixed(0)} ms)\n  self:\n${top(self, Math.ceil(topN / 2))}\n  inclusive:\n${top(incl, topN)}`);
  }
}

async function profileLaunch() {
  let result;
  const { fixture, visible } = await launchHeld({
    attach: (call, page) => [
      call('Page.enable', {}, page),
      call('Profiler.enable', {}, page),
      call('Profiler.setSamplingInterval', { interval: 200 }, page),
      call('Profiler.start', {}, page),
      call('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_LONG_TASKS }, page),
    ],
    finish: async (call, page, _events, stalls) => {
      const { profile } = await call('Profiler.stop', {}, page);
      const out = process.env.OFFICE_PROFILE_OUT ?? '/tmp/office-shots/startup.cpuprofile';
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(profile));
      result = { profile, stalls, out };
    },
  });
  console.log(`fixture ${fixture}, window ${visible ? 'shown' : 'hidden'}, load ${loadavg().map((l) => l.toFixed(1)).join(' ')}, profile ${result.out}`);
  report(result.profile, result.stalls.filter(([s]) => s < 10_000));
}

if (process.argv[2] === '--analyze') report(JSON.parse(readFileSync(process.argv[3], 'utf8')));
else await profileLaunch();
