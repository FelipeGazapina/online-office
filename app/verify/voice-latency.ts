// No Electron. What the owner feels from the voice service and what the whisper-server costs while it runs: the time from the
// end of an utterance to its transcript with the server warm, the cost of starting it, and (on the lifecycle build) the same
// transcript time when the server was asleep and woke at the start of the utterance, and the server's phys_footprint.
// It runs unchanged on the old build, where the server is always up, so before and after are the same script.
// Run from app/: node verify/voice-latency.ts [--quality=fast|accurate] [--runs=5]   Needs whisper-cpp, the models in the cache and macOS `say`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceEngine, VoiceQuality } from '../src/shared/voice.ts';
import { createWhisper, type Whisper } from '../src/main/voice/whisper.ts';
import { sleep } from './check.ts';
import { bytesOf, say } from './wav.ts';

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const quality = arg('quality', 'fast') as VoiceQuality;
const runs = Number(arg('runs', '5'));
const dir = mkdtempSync(join(tmpdir(), 'voice-latency-'));
const pidFile = join(dir, 'whisper.pid');
const events: { at: number; engine: VoiceEngine }[] = [];
const t0 = Date.now();

type Service = Whisper & { wake?: () => Promise<void> };
// The old build has no idle period and ignores `idleMs`.
const make = (idleMs: number): Service =>
  createWhisper({
    cacheDir: join(homedir(), 'Library/Caches/online-office/whisper'),
    pidFile,
    onEngine: (engine) => events.push({ at: Date.now() - t0, engine }),
    idleMs,
  } as Parameters<typeof createWhisper>[0]);
const service = make(10 * 60_000);
const lifecycle = typeof service.wake === 'function';

// The whisper-server of this run: the member of the supervisor's process group that is not the shell.
function serverPid(): number | null {
  try {
    const supervisor = JSON.parse(readFileSync(pidFile, 'utf8')).pid as number;
    const rows = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).split('\n');
    for (const row of rows) {
      const [pid, pgid] = row.trim().split(/\s+/);
      if (pgid === String(supervisor) && row.includes('whisper-server') && !/\s\/bin\/(sh|dash)\s/.test(row)) return Number(pid);
    }
  } catch {
    // no pid file means no server
  }
  return null;
}

function footprintMiB(pid: number): number {
  const out = join(dir, 'fp.json');
  execFileSync('footprint', ['-j', out, String(pid)], { stdio: 'ignore' });
  return Math.round((JSON.parse(readFileSync(out, 'utf8')).processes[0].footprint as number) / 1048576);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const settled = (ms: number) => sleep(ms);
const IDLE_FOR_COLD_MS = 800;
const report: Record<string, unknown> = { quality, build: lifecycle ? 'lifecycle' : 'always-on' };
const log = (line: string) => console.log(line);

const speech = say('Samantha', 'Can you draw a diagram of how the billing service talks to the queue?');
const short = say('Samantha', 'Please open the billing board.');
log(`clips: long ${(speech.length / 16000).toFixed(1)} s, short ${(short.length / 16000).toFixed(1)} s`);

// Boot: what the old build did on every launch. On the lifecycle build `use` only puts the files on disk.
let at = Date.now();
await service.use(quality);
report.useMs = Date.now() - at;
log(`use(${quality}) resolved in ${report.useMs} ms, engine ${JSON.stringify(service.engine())}, server running: ${serverPid() !== null}`);
report.serverAfterBoot = serverPid() !== null;

if (lifecycle) {
  at = Date.now();
  await service.wake!();
  report.wakeToReadyMs = Date.now() - at;
  log(`wake() to ready: ${report.wakeToReadyMs} ms`);
}
const pid = serverPid();
if (pid === null) throw new Error('no whisper-server is running');
await settled(500);
report.footprintReadyMiB = footprintMiB(pid);

// Warm: the server has answered its warm-ups, and now answers utterances.
const warm: number[] = [];
const warmShort: number[] = [];
for (let i = 0; i < runs; i++) {
  at = Date.now();
  const text = await service.transcribe(bytesOf(speech), 'en');
  warm.push(Date.now() - at);
  if (i === 0) log(`warm transcript: "${text}"`);
  at = Date.now();
  await service.transcribe(bytesOf(short), 'en');
  warmShort.push(Date.now() - at);
}
report.warmLongMs = warm;
report.warmShortMs = warmShort;
report.warmLongMedian = median(warm);
report.warmShortMedian = median(warmShort);
report.footprintAfterTalkMiB = footprintMiB(pid);
log(`warm, long clip: ${warm.join(' ')} ms (median ${median(warm)}); short clip: ${warmShort.join(' ')} ms (median ${median(warmShort)})`);
log(`whisper-server phys_footprint: ${report.footprintReadyMiB} MiB when ready, ${report.footprintAfterTalkMiB} MiB after ${runs * 2} utterances`);

if (lifecycle) {
  // Cold: the server is asleep, the owner starts to speak (wake), talks for D seconds, and the clip reaches transcribe().
  // A second service whose idle period is short, so it falls asleep by itself between samples.
  await service.stop();
  const napper = make(IDLE_FOR_COLD_MS);
  await napper.use(quality);
  const asleep = async () => {
    for (let waited = 0; napper.engine().kind !== 'asleep'; waited += 50) {
      if (waited > 30_000) throw new Error(`the service did not fall asleep: ${JSON.stringify(napper.engine())}`);
      await sleep(50);
    }
    await sleep(300);
  };
  const cold: Record<string, number[]> = {};
  for (const [name, clip, base] of [['long', speech, median(warm)], ['short', short, median(warmShort)]] as const) {
    for (const talkS of [0.5, 1, 2, 3]) {
      const samples: number[] = [];
      for (let i = 0; i < Math.max(2, Math.ceil(runs / 2)); i++) {
        await asleep();
        const wokeAt = Date.now();
        void napper.wake!();
        await sleep(Math.max(0, talkS * 1000 - (Date.now() - wokeAt)));
        at = Date.now();
        await napper.transcribe(bytesOf(clip), 'en');
        samples.push(Date.now() - at);
      }
      cold[`${name}@${talkS}s`] = samples;
      log(`cold, ${name} clip, owner spoke for ${talkS} s after the server woke: ${samples.join(' ')} ms (median ${median(samples)}, warm ${base}, added ${median(samples) - base})`);
    }
  }
  report.cold = cold;
  await asleep();
  report.serverAfterSleep = serverPid() !== null;
  log(`after sleeping: server running ${report.serverAfterSleep}`);
  await napper.stop();
} else {
  await service.stop();
}

log(`engine events: ${events.map((e) => `${e.at}ms ${e.engine.kind}`).join(', ')}`);
log(`REPORT ${JSON.stringify(report)}`);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
