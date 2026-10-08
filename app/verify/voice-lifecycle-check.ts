// No Electron, no model, no network. When whisper-server runs: it does not exist until the owner talks, it loads while they talk,
// it is gone after the idle period, and nothing the owner does in between can reach a server that is on its way out.
// A stand-in server with the same flags runs under the real service, so the processes counted here are real.
// Run from app/: node verify/voice-lifecycle-check.ts   Exits 1 on any failed check.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VoiceEngine } from '../src/shared/voice.ts';
import type { ModelSet } from '../src/main/voice/models.ts';
import { IDLE_MS, createWhisper, type Whisper, type WhisperOptions } from '../src/main/voice/whisper.ts';
import { check, finish, sleep, until } from './check.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fake = join(appDir, 'verify/fake-whisper-server.mjs');
const dir = mkdtempSync(join(tmpdir(), 'voice-lifecycle-'));
const cache = join(dir, 'cache');
mkdirSync(cache);
for (const file of ['fast.bin', 'accurate.bin', 'vad.bin']) writeFileSync(join(cache, file), file);
// The files are in the cache, so nothing is downloaded and these addresses are never used.
const models: ModelSet = {
  quality: { fast: { file: 'fast.bin', url: 'http://127.0.0.1:9/fast.bin' }, accurate: { file: 'accurate.bin', url: 'http://127.0.0.1:9/accurate.bin' } },
  vad: { file: 'vad.bin', url: 'http://127.0.0.1:9/vad.bin' },
};

const services: Whisper[] = [];
function newService(name: string, extra: Partial<WhisperOptions> = {}) {
  const events: VoiceEngine[] = [];
  const pidFile = join(dir, `${name}.pid`);
  const service = createWhisper({ cacheDir: cache, pidFile, models, locate: async () => fake, onEngine: (e) => events.push(e), ...extra });
  services.push(service);
  return { service, events, pidFile };
}

// Every stand-in server of this run, not counting the shells that supervise them.
function servers(): number[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(dir) && !/^\s*\d+\s+\/bin\/(sh|dash)\s/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}
const everything = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(dir));
const gone = (ms = 5000) => until(() => everything().length === 0, ms);

const watchdog = setTimeout(() => {
  console.error('FAIL: voice-lifecycle-check ran for 2 minutes');
  cleanup();
  process.exit(1);
}, 120_000);
watchdog.unref();

function cleanup() {
  for (const line of everything()) {
    try {
      process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// The stand-in answers in 20 ms, so a server loads in a fraction of a second and the idle period can be short.
process.env.FAKE_WHISPER_DELAY_MS = '20';
const IDLE = 900;
const asleep = (s: Whisper) => until(() => s.engine().kind === 'asleep', 10_000);

console.log('# nothing runs until the owner talks');
{
  check(IDLE_MS >= 30_000 && IDLE_MS <= 300_000, `the default idle period is ${IDLE_MS / 1000} s, long enough for a back and forth and short enough to matter`);
  const { service, events, pidFile } = newService('boot', { idleMs: IDLE });
  await service.use('fast');
  check(service.engine().kind === 'asleep', `use() puts the model on disk and the engine asleep (${JSON.stringify(service.engine())})`);
  await sleep(300);
  check(everything().length === 0 && !existsSync(pidFile), 'and no process and no pid file exist');
  check(!events.some((e) => e.kind === 'ready'), `the engine never claimed to be ready (${events.map((e) => e.kind)})`);

  console.log('\n# a wake loads the server, and the idle period unloads it');
  const woke = Date.now();
  await service.wake();
  const ready = service.engine();
  check(ready.kind === 'ready' && ready.model === 'fast.bin', `wake() resolves once the server is ready (${JSON.stringify(ready)}) after ${Date.now() - woke} ms`);
  const [first] = servers();
  check(servers().length === 1 && existsSync(pidFile), 'exactly one server runs, and a pid file names it');
  await sleep(IDLE * 0.6);
  void service.wake();
  await sleep(IDLE * 0.6);
  void service.wake();
  await sleep(IDLE * 0.6);
  check(servers().join() === String(first), `a wake every ${Math.round(IDLE * 0.6)} ms keeps the same server up past the ${IDLE} ms idle period`);
  const quietFrom = Date.now();
  check(await asleep(service), 'with no more wakes the engine falls asleep');
  check(Date.now() - quietFrom >= IDLE * 0.3 && Date.now() - quietFrom <= IDLE * 3, `after about the idle period (${Date.now() - quietFrom} ms)`);
  check(await gone(), `and no server, no shell around it and no pid file are left (${everything().length} processes)`);
  check(!existsSync(pidFile), 'the pid file is gone');
  check(!events.some((e) => e.kind === 'error'), 'none of that reported an error');

  console.log('\n# a request wakes it by itself');
  const said = await service.transcribe(new Uint8Array(64_000), 'en');
  check(said === 'fake words', `transcribe() on a sleeping engine starts the server and answers ("${said}")`);
  check(servers().length === 1, 'and leaves a server running');
  check(await asleep(service), 'which falls asleep again after the idle period');
  await service.stop();
}

console.log('\n# a request in flight is not idle');
{
  process.env.FAKE_WHISPER_DELAY_MS = String(IDLE * 3);
  process.env.FAKE_WHISPER_SLOW_AFTER = '1';
  const { service } = newService('flight', { idleMs: IDLE });
  await service.wake();
  const pending = service.transcribe(new Uint8Array(64_000), 'en');
  await sleep(IDLE * 2);
  check(service.engine().kind === 'ready' && servers().length === 1, `a request that takes ${IDLE * 3} ms keeps the server up past the ${IDLE} ms idle period`);
  check((await pending) === 'fake words', 'and gets its answer');
  check(await asleep(service), 'the idle period counts from the answer');
  await service.stop();
  process.env.FAKE_WHISPER_DELAY_MS = '20';
  delete process.env.FAKE_WHISPER_SLOW_AFTER;
}

console.log('\n# a request that arrives while the server goes down');
{
  const { service, events } = newService('race', { idleMs: IDLE });
  await service.wake();
  let answers = 0;
  for (let round = 0; round < 4; round++) {
    // The moment the engine says asleep, the old server may still be dying. A request now must get a new one.
    await asleep(service);
    const reply = await service.transcribe(new Uint8Array(64_000), 'en').catch((err: Error) => `FAILED: ${err.message}`);
    if (reply === 'fake words') answers++;
    else console.log(`round ${round}: ${reply}`);
  }
  check(answers === 4, `four requests, each sent the moment the engine fell asleep, all got an answer (${answers})`);
  check(!events.some((e) => e.kind === 'error'), `and none of the rounds reported an error (${events.map((e) => e.kind)})`);
  check(servers().length <= 1, 'and at most one server runs');
  await service.stop();
  check(await gone(), 'stop() leaves nothing');
}

console.log('\n# a request that arrives while the old server is still dying');
{
  process.env.FAKE_WHISPER_DIE_MS = '600';
  const { service, events } = newService('dying', { idleMs: IDLE });
  await service.wake();
  // The idle period has just run out and the old server is taking 600 ms to end.
  await sleep(IDLE + 150);
  check(service.engine().kind === 'asleep' && servers().length === 1, `the engine says asleep while the old server is still ending (${JSON.stringify(service.engine())}, ${servers().length} process)`);
  const reply = await service.transcribe(new Uint8Array(64_000), 'en').catch((err: Error) => `FAILED: ${err.message}`);
  check(reply === 'fake words', `a request sent then waits for a new server and gets its answer ("${reply}")`);
  check(!events.some((e) => e.kind === 'error'), `without an error on the way (${events.map((e) => e.kind)})`);
  await service.stop();
  delete process.env.FAKE_WHISPER_DIE_MS;
  check(await gone(), 'stop() leaves nothing');
}

console.log('\n# a slow load is not idle time');
{
  process.env.FAKE_WHISPER_START_MS = String(Math.round(IDLE * 1.5));
  const { service } = newService('slow', { idleMs: IDLE });
  await service.wake();
  const readyAt = Date.now();
  check(service.engine().kind === 'ready', `the server took more than ${Math.round(IDLE * 1.5)} ms to load, longer than the idle period, and is ready`);
  await sleep(IDLE * 0.6);
  check(service.engine().kind === 'ready' && servers().length === 1, `${Math.round(IDLE * 0.6)} ms after it was ready it is still up, because the idle period counts from ready (${Date.now() - readyAt} ms)`);
  await service.stop();
  delete process.env.FAKE_WHISPER_START_MS;
  check(await gone(), 'stop() leaves nothing');
}

console.log('\n# choosing the model');
{
  const { service } = newService('quality', { idleMs: 30_000 });
  await service.use('fast');
  await service.use('accurate');
  check(service.engine().kind === 'asleep' && everything().length === 0, 'choosing Accurate while asleep loads nothing');
  await service.wake();
  const turbo = service.engine();
  check(turbo.kind === 'ready' && turbo.model === 'accurate.bin', `the next wake starts on Accurate (${JSON.stringify(turbo)})`);
  const [before] = servers();
  await service.use('accurate');
  check(servers().join() === String(before), 'asking again for the model it runs does not restart the server');
  await service.use('fast');
  const small = service.engine();
  check(small.kind === 'ready' && small.model === 'fast.bin' && servers().length === 1 && servers()[0] !== before, `choosing Fast while running moves the server onto it and leaves one (${JSON.stringify(small)})`);
  await Promise.all([service.use('accurate'), service.use('fast'), service.use('accurate')]);
  const last = service.engine();
  check(last.kind === 'ready' && last.model === 'accurate.bin' && servers().length === 1, `three choices in a row end on the last one (${JSON.stringify(last)})`);
  await service.stop();
  check(await gone(), 'stop() leaves nothing');

  const overlap = newService('overlap', { idleMs: 30_000 });
  const started = overlap.service.use('fast');
  const woken = overlap.service.wake();
  await Promise.all([started, woken]);
  check(overlap.service.engine().kind === 'ready' && servers().length === 1, 'a wake that arrives before use() has finished still ends on one running server');
  await overlap.service.stop();
  check(await gone(), 'stop() leaves nothing');
}

console.log('\n# a server that dies');
{
  const { service, events } = newService('crash', { idleMs: 30_000 });
  await service.wake();
  const [victim] = servers();
  process.kill(victim!, 'SIGKILL');
  check(await until(() => service.engine().kind === 'error', 5000), `a server killed from outside is an error on the HUD (${JSON.stringify(service.engine())})`);
  check(await service.transcribe(new Uint8Array(64_000), 'en').then(() => false, (err: Error) => err.message.includes('whisper-server')), 'and a request says why it cannot serve');
  await service.recheck();
  await service.wake();
  check(service.engine().kind === 'ready' && servers().length === 1 && servers()[0] !== victim, `Try again and the next talk bring up a new one (${events.map((e) => e.kind)})`);
  await service.stop();
  check(await gone(), 'stop() leaves nothing');
}

console.log('\n# a missing binary shows before anyone talks');
{
  const { service } = newService('missing', { locate: async () => null, idleMs: IDLE });
  await service.use('fast');
  check(service.engine().kind === 'missing_binary', 'the engine says whisper-server is missing at launch');
  check(await service.transcribe(new Uint8Array(64_000), 'en').then(() => false, (err: Error) => err.message.includes('not installed')), 'and a request says so');
  await service.stop();
}

console.log('\n# quitting');
{
  const { service, pidFile } = newService('quit', { idleMs: 30_000 });
  await service.wake();
  const waiting = service.transcribe(new Uint8Array(64_000), 'en').then(() => 'answered', (err: Error) => err.message);
  const stopping = service.stop();
  check(!existsSync(pidFile), 'stop() has signalled the server, and cleared its pid file, before it returns');
  await stopping;
  check(['answered', 'The voice engine has stopped'].includes(await waiting), `a request sent just before stop() is answered or told the engine stopped (${await waiting})`);
  check(await gone(), 'no server, no shell and no pid file are left');
  check(await service.transcribe(new Uint8Array(64_000), 'en').then(() => false, () => true), 'a stopped service refuses new requests');
  check(await service.wake().then(() => true), 'and a wake after stop() is ignored, not an error');
  check(everything().length === 0, 'and starts nothing');
}

cleanup();
finish();
