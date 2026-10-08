// No Electron. The real whisper service against the real whisper-server, the real models and clips made with `say`.
// It checks what the owner's voice depends on: the words that come out, one request at a time, downloads that resume,
// and a server that never outlives the service. Needs whisper-cpp (brew install whisper-cpp) and macOS `say`.
// Run from app/: node verify/voice-check.ts [--offline]   Exits 1 on any failed check. --offline skips the Hugging Face download.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { VoiceEngine } from '../src/shared/voice.ts';
import { voiceAssets } from '../src/main/voice/assets.ts';
import { findBinary } from '../src/main/voice/binary.ts';
import { ensureModel, MODELS, type ModelSet } from '../src/main/voice/models.ts';
import { cleanTranscript, killLeftover } from '../src/main/voice/server.ts';
import { createWhisper, type Whisper } from '../src/main/voice/whisper.ts';
import { PCM_WORKLET_SOURCE } from '../src/main/voice/worklet.ts';
import { check, finish, sleep, until } from './check.ts';
import { bytesOf, say, writeWav } from './wav.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const dir = mkdtempSync(join(tmpdir(), 'voice-check-'));
const realCache = join(homedir(), 'Library/Caches/online-office/whisper');
const services: Whisper[] = [];
const children: ChildProcess[] = [];

const watchdog = setTimeout(() => {
  console.error('FAIL: voice-check ran for 5 minutes');
  cleanup();
  process.exit(1);
}, 300_000);
watchdog.unref();

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const hears = (text: string, words: string[]) => words.every((w) => norm(text).includes(w));

// Every whisper-server this check started has the scratch folder in its command line, whatever launched it. The supervisor
// shell and its watcher carry the same command line, so a process is a server only when it is not one of those.
function scratchProcesses(): { pid: number; supervisor: boolean }[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('whisper-server') && line.includes(dir))
    .map((line) => ({ pid: Number(line.trim().split(/\s+/)[0]), supervisor: /^\d+\s+\/bin\/(sh|dash)\s/.test(line.trim()) }));
}
const serversUnderScratch = () => scratchProcesses().filter((p) => !p.supervisor).map((p) => p.pid);
const everythingUnderScratch = () => scratchProcesses().map((p) => p.pid);

function cleanup() {
  for (const pid of everythingUnderScratch()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const child of children) child.kill('SIGKILL');
}

function newService(name: string, extra: Partial<Parameters<typeof createWhisper>[0]> = {}) {
  const events: VoiceEngine[] = [];
  const cacheDir = extra.cacheDir ?? cache;
  const pidFile = join(dir, `${name}.pid`);
  const service = createWhisper({ cacheDir, pidFile, onEngine: (e) => events.push(e), ...extra });
  services.push(service);
  return { service, events, pidFile };
}

async function section(name: string, body: () => Promise<void>) {
  console.log(`\n# ${name}`);
  try {
    await body();
  } catch (err) {
    check(false, `${name} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const cache = join(dir, 'cache');
mkdirSync(cache);

console.log('# setup');
const binary = await findBinary('whisper-server');
check(binary !== null, `found whisper-server (${binary})`);
for (const spec of [MODELS.quality.fast, MODELS.quality.accurate, MODELS.vad]) {
  await ensureModel({ spec, dir: realCache, onProgress: ({ received, total }) => process.stdout.write(`\r  downloading ${spec.file} ${Math.round((received / total) * 100)}%`) });
  symlinkSync(join(realCache, spec.file), join(cache, spec.file));
}
const en = say('Samantha', 'Can you draw a diagram of how the billing service talks to the queue?');
const enLong = say('Samantha', 'Please refactor the auth module and run the unit tests before you open a pull request.');
const pt = say('Luciana', 'Pode rodar os testes e depois me mostra o diagrama.');
const silence = new Int16Array(48_000);
const noise = Int16Array.from({ length: 48_000 }, () => Math.round((Math.random() - 0.5) * 3000));
check(en.length > 32_000 && pt.length > 32_000, `made an English clip (${(en.length / 16000).toFixed(1)} s) and a Portuguese clip (${(pt.length / 16000).toFixed(1)} s) with say`);

await section('finding the binary', async () => {
  const dock = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), SHELL: process.env.SHELL };
  const found = await findBinary('whisper-server', dock);
  check(found !== null && existsSync(found), `whisper-server is found under a Dock launch PATH (${found})`);
  const t0 = Date.now();
  check((await findBinary('definitely-not-installed-xyz', dock)) === null, `a missing binary is null, after ${Date.now() - t0} ms in the login shell`);
});

await section('cleaning transcripts', async () => {
  check(cleanTranscript(' [BLANK_AUDIO] ') === '', '[BLANK_AUDIO] is not speech');
  check(cleanTranscript('(clicking) (beeping)') === '', 'parenthesised sound tags are not speech');
  check(cleanTranscript('[Music]\n♪ ♪') === '', 'music is not speech');
  check(cleanTranscript('.') === '', 'a lone period is not speech');
  check(cleanTranscript('(laughs) Use  Postgres,\nnot SQLite.') === 'Use Postgres, not SQLite.', 'a tag before speech is dropped and the speech is kept');
});

await section('the worklet', async () => {
  const posted: { pcm: Int16Array; rmsDb: number }[] = [];
  let Processor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
  class AudioWorkletProcessor {
    port = { postMessage: (m: { pcm: Int16Array; rmsDb: number }) => void posted.push(m) };
  }
  vm.runInContext(PCM_WORKLET_SOURCE, vm.createContext({ AudioWorkletProcessor, registerProcessor: (_: string, c: typeof Processor) => (Processor = c), Float32Array, Int16Array, Math }));
  check(Processor !== undefined, "the worklet registers a processor named 'pcm'");
  const p = new Processor!();
  const quantum = (from: number, amp: number) => Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * (from + i)) / 16000));
  for (let q = 0; q < 9; q++) p.process([[quantum(q * 128, 0.5)]]);
  check(posted.length === 2, `1152 samples make two 512-sample blocks and hold 128 back (${posted.length} blocks)`);
  check(posted[0]!.pcm.length === 512 && posted[0]!.pcm instanceof Int16Array, 'a block is 512 Int16 samples');
  check(Math.abs(Math.max(...posted[0]!.pcm) - 16383) < 200, `a 0.5 sine peaks near 16383 (${Math.max(...posted[0]!.pcm)})`);
  check(Math.abs(posted[0]!.rmsDb - -9.03) < 0.3, `its level is about -9 dB (${posted[0]!.rmsDb.toFixed(2)})`);
  for (let q = 0; q < 3; q++) p.process([[new Float32Array(128)]]);
  posted.length = 0;
  for (let q = 0; q < 4; q++) p.process([[new Float32Array(128)]]);
  check(posted.length === 1 && posted[0]!.pcm.every((v) => v === 0), 'digital silence is a block of zeros');
  check(posted[0]!.rmsDb <= -119, `and reads -120 dB, which is how the renderer tells a dead mic (${posted[0]!.rmsDb})`);
  check(p.process([[]]) === true && p.process([[new Float32Array(0)]]) === true, 'a node with no input keeps the processor alive');
});

await section('the asset protocol', async () => {
  const serve = voiceAssets();
  const wasm = await serve('office-voice://assets/ort-wasm-simd-threaded.wasm');
  const onDisk = statSync(join(appDir, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')).size;
  check(wasm.status === 200 && wasm.headers.get('content-type') === 'application/wasm', 'the wasm is served as application/wasm, which streaming compilation needs');
  check((await wasm.arrayBuffer()).byteLength === onDisk, `and arrives whole (${onDisk} bytes)`);
  check(wasm.headers.get('access-control-allow-origin') === '*', 'every asset allows the cross-origin fetch from file:// and the dev server');
  const onnx = await serve('office-voice://assets/silero_vad_v5.onnx');
  check(onnx.status === 200 && (await onnx.arrayBuffer()).byteLength === 2_327_524, 'the Silero model is served whole');
  check((await (await serve('office-voice://assets/pcm-worklet.js')).text()) === PCM_WORKLET_SOURCE, 'the worklet is served from its source string');
  check((await serve('office-voice://assets/ort-wasm-simd-threaded.mjs')).headers.get('content-type') === 'text/javascript', 'the onnxruntime loader is served as a JavaScript module');
  check((await serve('office-voice://assets/vad.worklet.bundle.min.js')).status === 200, 'the vad-web worklet is served');
  for (const entry of ['out/main/index.js', 'out/verify/main/index.js', 'src/main/voice/assets.ts']) {
    const fromEntry = await voiceAssets(pathToFileURL(join(appDir, entry)))('office-voice://assets/ort-wasm-simd-threaded.wasm');
    check(fromEntry.status === 200 && (await fromEntry.arrayBuffer()).byteLength === onDisk, `the assets are found from an app entry at ${entry}, so where the app starts from cannot matter`);
  }
  const lost = await voiceAssets(pathToFileURL(join(dir, 'nowhere/main/index.js')))('office-voice://assets/silero_vad_v5.onnx');
  check(lost.status === 500, 'an entry outside the app tree gets a 500 for a package it cannot find and not a crash');
  for (const bad of ['office-voice://assets/../package.json', 'office-voice://assets/%2e%2e/package.json', 'office-voice://assets/constructor', 'office-voice://assets/', 'office-voice://elsewhere/pcm-worklet.js', 'https://assets/pcm-worklet.js']) {
    check((await serve(bad)).status === 404, `${bad} is a 404`);
  }
});

await section('the real service on the fast model', async () => {
  const { service, events, pidFile } = newService('fast');
  await service.use('fast');
  check(service.engine().kind === 'asleep' && everythingUnderScratch().length === 0 && !existsSync(pidFile), `use('fast') only puts the model on disk, and no server runs (${JSON.stringify(service.engine())})`);
  await service.wake();
  const engine = service.engine();
  check(engine.kind === 'ready' && engine.model === 'ggml-small-q5_1.bin', `the engine is ready on small-q5_1 (${JSON.stringify(engine)})`);
  check(!events.some((e) => e.kind === 'error' || e.kind === 'missing_binary'), `it never reported an error on the way (${events.map((e) => e.kind)})`);
  check(serversUnderScratch().length === 1, 'exactly one whisper-server is running');
  check(existsSync(pidFile), 'a pid file names it');

  const said = await service.transcribe(bytesOf(en), 'en');
  check(hears(said, ['diagram', 'billing', 'queue']), `English with en: "${said}"`);
  const saidPt = await service.transcribe(bytesOf(pt), 'pt');
  check(hears(saidPt, ['rodar', 'testes', 'diagrama']), `Portuguese with pt: "${saidPt}"`);
  const saidAuto = await service.transcribe(bytesOf(pt), 'auto');
  check(hears(saidAuto, ['rodar', 'testes', 'diagrama']), `Portuguese with auto: "${saidAuto}"`);
  check((await service.transcribe(bytesOf(silence), 'en')) === '', 'three seconds of silence come back as no words');
  check((await service.transcribe(bytesOf(noise), 'auto')) === '', 'three seconds of noise come back as no words');

  const order: string[] = [];
  const first = service.transcribe(bytesOf(enLong), 'en').then((t) => (order.push('first'), t));
  const second = service.transcribe(bytesOf(pt), 'pt').then((t) => (order.push('second'), t));
  const [a, b] = await Promise.all([first, second]);
  check(order.join() === 'first,second', 'two requests sent together finish in the order they were sent');
  check(hears(a, ['refactor', 'unit tests']) && hears(b, ['rodar', 'testes']), `and neither is lost or mixed up ("${a}" and "${b}")`);

  const pidBefore = readFileSync(pidFile, 'utf8');
  await service.use('fast');
  await service.wake();
  check(readFileSync(pidFile, 'utf8') === pidBefore, 'asking for the model it already runs, or waking it again, does not restart the server');

  await service.stop();
  check(everythingUnderScratch().length === 0, 'after stop() no whisper-server, and no supervisor around it, is left');
  check(!existsSync(pidFile), 'and the pid file is gone');
  check(await service.transcribe(bytesOf(en), 'en').then(() => false, () => true), 'a stopped service refuses new requests');
});

await section('switching between fast and accurate', async () => {
  const { service } = newService('switch');
  await service.use('fast');
  await service.wake();
  await service.use('accurate');
  const engine = service.engine();
  check(engine.kind === 'ready' && engine.model === 'ggml-large-v3-turbo-q5_0.bin', `accurate runs turbo-q5_0 (${JSON.stringify(engine)})`);
  check(serversUnderScratch().length === 1, 'and the small server is gone, so one whisper-server runs');
  const said = await service.transcribe(bytesOf(pt), 'pt');
  check(hears(said, ['rodar', 'os testes', 'diagrama']), `turbo hears Portuguese: "${said}"`);

  const settled = Promise.all([service.use('fast'), service.use('accurate'), service.use('fast')]);
  await settled;
  const after = service.engine();
  check(after.kind === 'ready' && after.model === 'ggml-small-q5_1.bin', `three switches in a row end on the last one (${JSON.stringify(after)})`);
  check(serversUnderScratch().length === 1, 'and leave exactly one server behind');
  await service.stop();
  check(everythingUnderScratch().length === 0, 'stop() leaves none');
});

await section('requests wait their turn', async () => {
  const log = join(dir, 'fake.log');
  process.env.FAKE_WHISPER_LOG = log;
  const { service } = newService('queue', { locate: async () => join(appDir, 'verify/fake-whisper-server.mjs') });
  await service.use('fast');
  await service.wake();
  check(service.engine().kind === 'ready', 'the service starts against a stand-in server that logs concurrency');
  const t0 = Date.now();
  const texts = await Promise.all([1, 2, 3, 4].map(() => service.transcribe(bytesOf(en), 'en')));
  const took = Date.now() - t0;
  const running = readFileSync(log, 'utf8').trim().split('\n').map((l) => Number(l.split('=')[1]));
  check(texts.every((t) => t === 'fake words'), 'four requests sent at once all get their answer');
  check(Math.max(...running) === 1, `the server never had two requests in flight (${running.length} requests, the busiest moment ${Math.max(...running)})`);
  check(took >= 4 * 200, `and they took ${took} ms, at least four times the server's 200 ms`);
  await service.stop();
  delete process.env.FAKE_WHISPER_LOG;
});

await section('quitting right after stop()', async () => {
  const fake = join(appDir, 'verify/fake-whisper-server.mjs');
  const probe = join(dir, 'quit-probe.ts');
  writeFileSync(
    probe,
    `import { createWhisper } from ${JSON.stringify(join(appDir, 'src/main/voice/whisper.ts'))};
const [, , cacheDir, pidFile, mode] = process.argv;
const service = createWhisper({ cacheDir, pidFile, locate: async () => ${JSON.stringify(fake)} });
await service.use('fast');
const started = service.wake();
if (mode === 'ready') await started;
else await new Promise((resolve) => setTimeout(resolve, 700));
void service.stop();
process.exit(0);
`,
  );
  for (const mode of ['ready', 'loading']) {
    const env = { ...process.env, FAKE_WHISPER_START_MS: mode === 'loading' ? '4000' : '0' };
    execFileSync('node', [probe, cache, join(dir, `quit-${mode}.pid`), mode], { env });
    check(await until(() => everythingUnderScratch().length === 0, 2000), `an app that quits the moment it calls stop() leaves no whisper-server behind, with the server ${mode}`);
    check(!existsSync(join(dir, `quit-${mode}.pid`)), `and no pid file, with the server ${mode}`);
  }
});

await section('an app that is killed', async () => {
  const clip = join(dir, 'en.wav');
  writeWav(clip, en);
  const probe = join(dir, 'parent-probe.ts');
  writeFileSync(
    probe,
    `import { createWhisper } from ${JSON.stringify(join(appDir, 'src/main/voice/whisper.ts'))};
import { bytesOf, readWav } from ${JSON.stringify(join(appDir, 'verify/wav.ts'))};
const [, , cacheDir, pidFile, shell, clip] = process.argv;
const service = createWhisper({ cacheDir, pidFile, shell });
await service.use('fast');
await service.wake();
console.log('up ' + (await service.transcribe(bytesOf(readWav(clip)), 'en')));
setInterval(() => {}, 1000);
`,
  );
  // dash is what /bin/sh is on Debian and Ubuntu, and macOS ships it, so it stands in for Linux here.
  for (const shell of ['/bin/sh', '/bin/dash']) {
    if (!existsSync(shell)) {
      console.log(`SKIP: ${shell} is not on this machine`);
      continue;
    }
    const pidFile = join(dir, `killed-${basename(shell)}.pid`);
    const app = spawn(process.execPath, [probe, cache, pidFile, shell, clip], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(app);
    const said = await new Promise<string>((done) => {
      let out = '';
      app.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const line = /up (.*)/.exec(out);
        if (line) done(line[1]!);
      });
      app.once('exit', () => done(''));
    });
    check(hears(said, ['diagram', 'billing', 'queue']), `${shell}: the server answers while its app is alive ("${said}")`);
    check(serversUnderScratch().length === 1 && everythingUnderScratch().length > 1, `${shell}: exactly one server runs, under a supervisor`);
    const killedAt = Date.now();
    app.kill('SIGKILL');
    const gone = await until(() => everythingUnderScratch().length === 0, 2000);
    check(gone, `${shell}: an app killed with SIGKILL takes its whisper-server with it, and none of its run is left after ${Date.now() - killedAt} ms`);
    check(existsSync(pidFile), `${shell}: the killed app could not remove its pid file`);
    await killLeftover(pidFile);
    check(!existsSync(pidFile), `${shell}: the next launch clears that stale pid file and kills nothing`);
  }

  const { service } = newService('dash', { shell: '/bin/dash' });
  if (existsSync('/bin/dash')) {
    await service.use('fast');
    await service.wake();
    check(service.engine().kind === 'ready', 'the service starts under dash');
    check(hears(await service.transcribe(bytesOf(en), 'en'), ['diagram', 'billing']), 'and transcribes under dash');
    await service.stop();
    check(everythingUnderScratch().length === 0, 'and stop() under dash leaves nothing');
  }
});

await section('a missing binary and checking again', async () => {
  let path: string | null = null;
  const { service, events } = newService('binary', { locate: async () => path });
  await service.use('fast');
  check(service.engine().kind === 'missing_binary', 'no whisper-server reports missing_binary');
  check(await service.transcribe(bytesOf(en), 'en').then(() => false, (e: Error) => e.message.includes('not installed')), 'a request says whisper-server is not installed');
  path = binary;
  await service.recheck();
  await service.wake();
  check(service.engine().kind === 'ready', `Check again finds it and the next talk makes the engine ready (${events.map((e) => e.kind)})`);
  await service.stop();
});

const junkModels = (base: string): ModelSet => ({
  quality: { fast: { file: 'fast.bin', url: `${base}/resolve/fast.bin` }, accurate: { file: 'accurate.bin', url: `${base}/resolve/accurate.bin` } },
  vad: { file: 'vad.bin', url: `${base}/resolve/vad.bin` },
});

// Hugging Face's shape: a HEAD answers 302 with the size and SHA-256, and the CDN serves ranges. Slow, so a test can cut it.
async function modelHost(files: Record<string, Buffer>, lie: string[] = []) {
  const ranges: string[] = [];
  const server: Server = createServer((req, res) => {
    const name = req.url?.split('/').pop() ?? '';
    const body = files[name];
    if (!body) return void res.writeHead(404).end();
    if (req.url?.startsWith('/resolve/')) {
      const sha = lie.includes(name) ? 'f'.repeat(64) : createHash('sha256').update(body).digest('hex');
      return void res.writeHead(302, { 'x-linked-size': body.length, 'x-linked-etag': `"${sha}"`, location: `http://127.0.0.1:${port()}/cdn/${name}` }).end();
    }
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (range) ranges.push(req.headers.range!);
    const from = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'content-length': body.length - from, ...(range ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    let at = from;
    const timer = setInterval(() => {
      if (at >= body.length || res.destroyed) return void (clearInterval(timer), res.end());
      res.write(body.subarray(at, at + 65_536));
      at += 65_536;
    }, 20);
    res.on('close', () => clearInterval(timer));
  });
  const port = () => (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port()}`, ranges, close: () => server.closeAllConnections() ?? server.close() };
}

await section('downloading a model that is missing', async () => {
  const model = randomBytes(1_500_000);
  const host = await modelHost({ 'fast.bin': model, 'vad.bin': randomBytes(4000) });
  const models = junkModels(host.url);
  const partsOf = (folder: string) => readdirSync(folder).filter((f) => f.endsWith('.part'));

  const fresh = join(dir, 'dl-fresh');
  const first = newService('dl-fresh', { cacheDir: fresh, models });
  await first.service.use('fast');
  check(first.service.engine().kind === 'asleep', `the model downloads at launch and the engine then sleeps (${JSON.stringify(first.service.engine())})`);
  await first.service.wake();
  const downloads = first.events.filter((e): e is Extract<VoiceEngine, { kind: 'downloading' }> => e.kind === 'downloading' && e.file === 'fast.bin');
  check(downloads.length >= 2, `the engine reported downloading with progress (${downloads.length} reports)`);
  check(downloads.every((d) => d.total === model.length) && downloads.every((d, i) => i === 0 || d.received >= downloads[i - 1]!.received), 'each report names the file, the full size, and never goes backwards');
  check(readFileSync(join(fresh, 'fast.bin')).equals(model), 'the file lands whole after its SHA-256 matched');
  check(partsOf(fresh).length === 0, 'and no .part file is left');
  const after = first.service.engine();
  check(after.kind === 'error' && after.message.includes('whisper-server'), `a model whisper cannot load is an error and not a crash (${JSON.stringify(after)})`);
  check(everythingUnderScratch().length === 0, 'and no server is left running');
  await first.service.stop();

  const cut = join(dir, 'dl-cut');
  const second = newService('dl-cut', { cacheDir: cut, models });
  const running = second.service.use('fast');
  check(await until(() => second.events.some((e) => e.kind === 'downloading' && e.file === 'fast.bin' && e.received > 0), 5000), 'a download is under way');
  await second.service.stop();
  await running;
  const part = statSync(join(cut, 'fast.bin.part')).size;
  check(part > 0 && part < model.length && !existsSync(join(cut, 'fast.bin')), `stop() cancels it and keeps the partial file for later (${part} of ${model.length} bytes)`);
  check(everythingUnderScratch().length === 0, 'and starts no server');

  const third = newService('dl-resume', { cacheDir: cut, models });
  await third.service.use('fast');
  check(host.ranges.includes(`bytes=${part}-`), `the next start asks for the rest with Range: bytes=${part}- (${host.ranges})`);
  check(readFileSync(join(cut, 'fast.bin')).equals(model), 'the resumed file matches the original byte for byte');
  await third.service.stop();
  host.close();

  const liar = await modelHost({ 'fast.bin': model, 'vad.bin': randomBytes(4000) }, ['fast.bin']);
  const bad = newService('dl-bad', { cacheDir: join(dir, 'dl-bad'), models: junkModels(liar.url) });
  await bad.service.use('fast');
  const badState = bad.service.engine();
  check(badState.kind === 'error' && badState.message.includes('SHA-256'), `a file that fails its hash is an error (${JSON.stringify(badState)})`);
  check(!existsSync(join(dir, 'dl-bad', 'fast.bin')) && partsOf(join(dir, 'dl-bad')).length === 0, 'and neither the file nor the partial one is kept');
  liar.close();
  await bad.service.stop();

  const nowhere = newService('dl-net', { cacheDir: join(dir, 'dl-net'), models: junkModels('http://127.0.0.1:9') });
  await nowhere.service.use('fast');
  check(nowhere.service.engine().kind === 'error', `an unreachable host is an error and not a crash (${JSON.stringify(nowhere.service.engine())})`);
  await nowhere.service.stop();

  const offlineStart = newService('offline', { cacheDir: cache, models: junkModels('http://127.0.0.1:9'), locate: async () => join(appDir, 'verify/fake-whisper-server.mjs') });
  await offlineStart.service.use('fast').catch(() => {});
  check(offlineStart.service.engine().kind === 'error', 'names that are not in the cache need the network');
  await offlineStart.service.stop();
  const cached = newService('cached', { cacheDir: cache, models: { ...MODELS }, locate: async () => join(appDir, 'verify/fake-whisper-server.mjs') });
  await cached.service.use('fast');
  await cached.service.wake();
  check(cached.service.engine().kind === 'ready', 'models already in the cache start without any network access');
  await cached.service.stop();
});

await section('a server that survived a crash', async () => {
  const pidFile = join(dir, 'crash.pid');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const orphan = spawn(binary!, ['-m', join(cache, MODELS.quality.fast.file), '--host', '127.0.0.1', '--port', String(port), '--vad', '-vm', join(cache, MODELS.vad.file)], { stdio: 'ignore' });
  children.push(orphan);
  writeFileSync(pidFile, JSON.stringify({ pid: orphan.pid }));
  check(await until(() => serversUnderScratch().includes(orphan.pid!), 3000), 'a leftover whisper-server from a killed app is running');

  const { service } = newService('crash', { pidFile });
  await service.use('fast');
  await service.wake();
  check(await until(() => !serversUnderScratch().includes(orphan.pid!), 5000), 'the next launch kills it');
  check(service.engine().kind === 'ready' && serversUnderScratch().length === 1, 'and starts its own, so one whisper-server runs');
  check(readFileSync(pidFile, 'utf8') !== JSON.stringify({ pid: orphan.pid }) && existsSync(pidFile), 'the pid file now names the new server');
  await service.stop();
  check(!existsSync(pidFile), 'and stop() clears it');

  const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(bystander);
  writeFileSync(pidFile, JSON.stringify({ pid: bystander.pid }));
  const careful = newService('careful', { pidFile });
  await careful.service.use('fast');
  await careful.service.wake();
  check(bystander.exitCode === null && bystander.signalCode === null, 'a pid file whose pid now belongs to another program is left alone');
  await careful.service.stop();
  bystander.kill('SIGKILL');

  writeFileSync(pidFile, 'not json');
  await killLeftover(pidFile);
  check(!existsSync(pidFile), 'a garbled pid file is just removed');
});

if (!offline) {
  await section('a real download from Hugging Face', async () => {
    const folder = join(dir, 'hf');
    const seen: number[] = [];
    // No answer at all is the network, and only the network. A wrong or missing header, a short file or a bad hash is the contract.
    const contract = /did not describe|SHA-256|stopped at|unexpected HTTP/;
    let path: string | null = null;
    let unreachable = '';
    for (let attempt = 1; attempt <= 3 && !path; attempt++) {
      try {
        path = await ensureModel({ spec: MODELS.vad, dir: folder, onProgress: ({ received }) => seen.push(received) });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (contract.test(reason)) throw err;
        unreachable = reason;
        await sleep(1000);
      }
    }
    if (!path) return void console.log(`SKIP: Hugging Face did not answer three times (${unreachable}). The local model host above covers the download logic.`);
    check(statSync(path).size === 885_098, `the Silero VAD model arrives whole (${statSync(path).size} bytes)`);
    check(seen.length > 0 && seen.at(-1) === 885_098, 'with progress up to its full size');
    check(!existsSync(`${path}.part`), 'and its SHA-256 matched the one Hugging Face publishes, or it would not be here');
    rmSync(folder, { recursive: true });
  });
}

cleanup();
check(everythingUnderScratch().length === 0, 'no whisper-server started by this check is still running');
rmSync(dir, { recursive: true, force: true });
finish();
