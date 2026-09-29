import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Language } from '../../shared/voice.ts';

export type ServerExit = { stopped: boolean; reason: string };

export type WhisperServer = {
  transcribe(pcm: Uint8Array, language: Language): Promise<string>;
  // SIGTERM has left before this returns, so a caller that quits right after cannot orphan the process. Resolves once it is gone.
  stop(): Promise<void>;
  // Resolves when the process ends. `stopped` tells a stop() from a crash.
  readonly exited: Promise<ServerExit>;
};

// Aborting `signal` cancels a start in progress and, after that, stops the server it started.
type StartOptions = { binary: string; model: string; vadModel: string; pidFile: string; signal?: AbortSignal; shell?: string };

const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KILL_AFTER_MS = 3000;
const WARM_UPS = 3;
// One second of 16 kHz Int16 silence.
const SILENCE = new Uint8Array(32_000);

// The server must not outlive the app, and an app that is killed cannot clean up after itself. macOS has no parent-death
// signal, so a shell supervises the server. The app holds the write end of a pipe to the shell's stdin, and nothing else
// does. However the app dies, the kernel closes that end, the shell's watcher reads end of file and kills the server.
// The server gets no stdin and not the pipe. A trapped signal ends `wait` early, so it waits again until the server is gone.
// The script runs in macOS's sh and in dash, which is Linux's.
const SUPERVISOR = [
  'exec 3<&0 0</dev/null;',
  '"$@" 3<&- &',
  'server=$!;',
  '( while read -r line <&3; do :; done; kill "$server" 2>/dev/null ) &',
  'watcher=$!;',
  `trap 'kill "$server" 2>/dev/null' TERM INT HUP;`,
  'wait "$server"; status=$?;',
  'while kill -0 "$server" 2>/dev/null; do wait "$server"; status=$?; done;',
  'kill "$watcher" 2>/dev/null; exit "$status"',
].join(' ');

const inferenceReply = z.object({ text: z.string() });
const pidRecord = z.object({ pid: z.number().int().positive() });

function wav16k(pcm: Uint8Array): Buffer<ArrayBuffer> {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

// For silence and noise whisper prints tags such as [BLANK_AUDIO], (clicking) or [Music], a lone "." or music notes.
// None of that is the owner talking.
export function cleanTranscript(text: string): string {
  const spoken = text
    .replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else.
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
};

// The pid file outlives a crash, and the pid may since belong to something else, so the command line is checked before any kill.
function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => execFile('ps', ['-p', String(pid), '-o', 'command='], (_err, stdout) => resolve(stdout)));
}

// The supervisor leads its own process group, so one signal to the group reaches the shell, its watcher and the server.
// A server without a supervisor leads no group, and the signal goes to its pid.
function signalTree(pid: number, sig: NodeJS.Signals) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, sig);
      return;
    } catch {
      // no such group, or no such process
    }
  }
}

// A previous run that was killed leaves its server behind. Windows has no ps, so it leaves the leftover alone.
export async function killLeftover(pidFile: string): Promise<void> {
  const raw = await readFile(pidFile, 'utf8').catch(() => null);
  if (raw === null) return;
  await rm(pidFile, { force: true });
  const record = pidRecord.safeParse(safeJson(raw));
  if (!record.success || process.platform === 'win32') return;
  const { pid } = record.data;
  if (!alive(pid) || !(await commandOf(pid)).includes('whisper-server')) return;
  signalTree(pid, 'SIGTERM');
  for (let waited = 0; alive(pid) && waited < KILL_AFTER_MS; waited += 50) await sleep(50);
  if (alive(pid)) signalTree(pid, 'SIGKILL');
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function post(base: string, pcm: Uint8Array, language: Language, extra: Record<string, string> = {}): Promise<string> {
  const body = new FormData();
  body.set('file', new Blob([wav16k(pcm)], { type: 'audio/wav' }), 'utterance.wav');
  body.set('response_format', 'json');
  body.set('temperature', '0.0');
  body.set('language', language);
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  const res = await fetch(`${base}/inference`, { method: 'POST', body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`whisper-server answered HTTP ${res.status}`);
  return cleanTranscript(inferenceReply.parse(await res.json()).text);
}

function describeExit(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const last = stderr.trim().split('\n').pop()?.trim();
  const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
  return last ? `whisper-server ${how}: ${last}` : `whisper-server ${how}`;
}

// Starts whisper-server on 127.0.0.1, on a random port and behind a random request path, because it answers every
// origin with Access-Control-Allow-Origin: * and any page in the owner's browser could otherwise post audio to it.
// It runs under a supervisor that ends it when this process dies, whatever killed this process.
export async function startServer(o: StartOptions): Promise<WhisperServer> {
  await killLeftover(o.pidFile);
  o.signal?.throwIfAborted();
  const port = await freePort();
  const requestPath = `/${randomBytes(12).toString('hex')}`;
  const base = `http://127.0.0.1:${port}${requestPath}`;
  const args = ['-m', o.model, '-l', 'auto', '-t', '4', '-bs', '1', '-bo', '2', '--host', '127.0.0.1', '--port', String(port), '--request-path', requestPath, '--vad', '-vm', o.vadModel];

  // Windows has no sh, so a killed app leaves the server there until the next launch kills it by pid file.
  const supervised = process.platform !== 'win32';
  const child = supervised
    ? spawn(o.shell ?? '/bin/sh', ['-c', SUPERVISOR, 'sh', o.binary, ...args], { stdio: ['pipe', 'ignore', 'pipe'], detached: true })
    : spawn(o.binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // The pipe stays open, unwritten, for as long as this child object lives.
  child.stdin?.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  let stopping = false;
  const gone: { exit: ServerExit | null } = { exit: null };
  const exited = new Promise<ServerExit>((resolve) => {
    const finish = (reason: string) => {
      rmSync(o.pidFile, { force: true });
      gone.exit = { stopped: stopping, reason };
      resolve(gone.exit);
    };
    child.once('exit', (code, signal) => finish(describeExit(code, signal, stderr)));
    child.once('error', (err) => finish(`whisper-server could not start: ${err.message}`));
  });

  if (child.pid !== undefined) {
    mkdirSync(dirname(o.pidFile), { recursive: true });
    writeFileSync(o.pidFile, JSON.stringify({ pid: child.pid, binary: o.binary }));
  }

  // Once the child has exited its pid may belong to something else, so nothing is signalled after that.
  const signalServer = (sig: NodeJS.Signals) => {
    if (child.pid !== undefined && !gone.exit) signalTree(child.pid, sig);
  };
  const stop = () => {
    if (!stopping) {
      stopping = true;
      signalServer('SIGTERM');
      rmSync(o.pidFile, { force: true });
      const timer = setTimeout(() => signalServer('SIGKILL'), KILL_AFTER_MS);
      void exited.then(() => clearTimeout(timer));
    }
    return exited.then(() => undefined);
  };
  // The signal's abort must reach the process in the same tick, because the app may quit right after aborting.
  o.signal?.addEventListener('abort', () => void stop(), { once: true });

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      o.signal?.throwIfAborted();
      if (gone.exit) throw new Error(gone.exit.reason);
      if (Date.now() > deadline) throw new Error(`whisper-server did not load ${o.model} within ${READY_TIMEOUT_MS / 1000} s`);
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (health?.ok) break;
      await sleep(50);
    }
    // The first requests are two to three times slower. Server-side VAD would skip silence, so it is off for these.
    for (let i = 0; i < WARM_UPS; i++) await post(base, SILENCE, 'en', { vad: 'false' });
  } catch (err) {
    await stop();
    throw err;
  }
  return { transcribe: (pcm, language) => post(base, pcm, language), stop, exited };
}
