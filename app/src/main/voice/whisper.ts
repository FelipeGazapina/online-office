import { basename } from 'node:path';
import type { Language, VoiceEngine, VoiceQuality } from '../../shared/voice.ts';
import { findBinary } from './binary.ts';
import { ensureModel, MODELS, type ModelSet } from './models.ts';
import { startServer, type WhisperServer } from './server.ts';

export type WhisperOptions = {
  // Where the models live. The pid file names the server of one app profile, so two profiles never kill each other's.
  cacheDir: string;
  pidFile: string;
  // How long the server stays up after the owner last talked. The default is `IDLE_MS`.
  idleMs?: number;
  onEngine?: (engine: VoiceEngine) => void;
  // Tests replace these to run against a stand-in server or a local model host, or under another shell.
  locate?: () => Promise<string | null>;
  models?: ModelSet;
  shell?: string;
};

export type Whisper = {
  engine(): VoiceEngine;
  // Chooses the model for this quality and puts it on disk. A running server moves onto it, and a sleeping one stays asleep.
  use(quality: VoiceQuality): Promise<void>;
  // The owner is talking, or about to be. Starts the server if it is not running and keeps it up for another idle period.
  // Resolves once the server is ready or has failed.
  wake(): Promise<void>;
  // Looks for the binary again, then retries.
  recheck(): Promise<void>;
  // One request at a time. Wakes the server and waits while it starts, and rejects when it cannot serve.
  transcribe(pcm: Uint8Array, language: Language): Promise<string>;
  stop(): Promise<void>;
};

// whisper-server holds the model in memory, 0.4 GB on Fast and more on Accurate, so it runs only while someone talks. A minute
// covers a back and forth with an employee, and a pause longer than that costs one load that the next utterance hides.
export const IDLE_MS = 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Running = { server: WhisperServer; quality: VoiceQuality; model: string };

export function createWhisper(o: WhisperOptions): Whisper {
  const models = o.models ?? MODELS;
  const locate = o.locate ?? (() => findBinary('whisper-server'));
  const idleMs = o.idleMs ?? IDLE_MS;
  // Looked up once, at startup. A missing binary costs a second in the login shell, so it is not asked per call.
  let binary = locate();
  let engine: VoiceEngine = { kind: 'starting' };

  // What is wanted: this quality, and a server only while `awake`. What is true: `running`. converge() makes one the other.
  let quality: VoiceQuality = 'fast';
  let awake = false;
  let running: Running | null = null;
  // The last bring-up failed, so the owner has to say when to try again (recheck, or another model).
  let blocked = false;
  let stopped = false;
  let controller = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const files = new Map<VoiceQuality, { vad: string; model: string }>();
  const waiting = new Set<() => void>();

  function set(next: VoiceEngine) {
    if (JSON.stringify(next) === JSON.stringify(engine)) return;
    engine = next;
    o.onEngine?.(next);
    for (const wake of waiting) wake();
    waiting.clear();
  }

  function fail(next: VoiceEngine) {
    blocked = true;
    set(next);
  }

  async function fetchFiles(q: VoiceQuality, signal: AbortSignal) {
    const fetchModel = (spec: ModelSet['vad']) =>
      ensureModel({
        spec,
        dir: o.cacheDir,
        signal,
        onProgress: ({ received, total }) => set({ kind: 'downloading', file: spec.file, received, total }),
      });
    const vad = await fetchModel(models.vad);
    return { vad, model: await fetchModel(models.quality[q]) };
  }

  // Puts the engine where `quality` and `awake` say, one step at a time, and looks again after every wait because either may
  // have changed meanwhile. It is idempotent, so any change just queues another pass.
  async function converge(): Promise<void> {
    for (;;) {
      if (stopped || blocked) return;
      const goal = { quality, awake };
      const { signal } = controller;
      const stale = () => stopped || quality !== goal.quality || awake !== goal.awake;

      if (running && (!goal.awake || running.quality !== goal.quality)) {
        const old = running;
        running = null;
        // A request that arrives while the old server goes down waits for the next one instead of finding a stale `ready`.
        set({ kind: goal.awake ? 'starting' : 'asleep' });
        await old.server.stop();
        continue;
      }
      try {
        const path = await binary;
        if (!path) return fail({ kind: 'missing_binary' });
        // The model goes to disk even while asleep, so the first talk does not wait for a download.
        const paths = files.get(goal.quality) ?? (await fetchFiles(goal.quality, signal));
        files.set(goal.quality, paths);
        if (stale()) continue;
        if (!goal.awake) return set({ kind: 'asleep' });
        if (running) return set({ kind: 'ready', model: basename(running.model) });

        set({ kind: 'starting' });
        const server = await startServer({ binary: path, model: paths.model, vadModel: paths.vad, pidFile: o.pidFile, signal, shell: o.shell });
        if (stale()) {
          await server.stop();
          continue;
        }
        running = { server, quality: goal.quality, model: paths.model };
        void server.exited.then((exit) => {
          if (running?.server !== server || exit.stopped) return;
          running = null;
          fail({ kind: 'error', message: exit.reason });
        });
        set({ kind: 'ready', model: basename(paths.model) });
        // The idle period counts from the moment the owner can be heard, not from the press that started the load.
        armIdle();
        return;
      } catch (err) {
        if (stale()) continue;
        return fail({ kind: 'error', message: message(err) });
      }
    }
  }

  function settle(): Promise<void> {
    chain = chain.then(converge).catch((err: unknown) => fail({ kind: 'error', message: message(err) }));
    return chain;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // A request in flight, or a server still loading, is someone talking.
      if (inFlight > 0 || engine.kind === 'starting' || engine.kind === 'downloading') return armIdle();
      awake = false;
      void settle();
    }, idleMs);
    idleTimer.unref();
  }

  function wake(): Promise<void> {
    if (stopped) return Promise.resolve();
    awake = true;
    armIdle();
    return settle();
  }

  async function serverWhenReady(): Promise<WhisperServer> {
    for (;;) {
      if (stopped) throw new Error('The voice engine has stopped');
      switch (engine.kind) {
        case 'ready':
          if (running) return running.server;
          throw new Error('The voice engine has no server');
        case 'starting':
        case 'asleep':
          await new Promise<void>((resolve) => waiting.add(resolve));
          continue;
        case 'downloading':
          throw new Error('The voice model is still downloading');
        case 'missing_binary':
          throw new Error('whisper-server is not installed');
        case 'error':
          throw new Error(engine.message);
        default: {
          const _exhaustive: never = engine;
          return _exhaustive;
        }
      }
    }
  }

  return {
    engine: () => engine,
    use(next) {
      if (stopped) return Promise.resolve();
      if (next !== quality) {
        quality = next;
        // The download or the start in progress is for the old model.
        controller.abort();
        controller = new AbortController();
      }
      blocked = false;
      return settle();
    },
    wake,
    recheck() {
      binary = locate();
      blocked = false;
      return settle();
    },
    transcribe(pcm, language) {
      inFlight++;
      // A request is the owner talking, even if nothing woke the server before it.
      void wake();
      const run = queue.then(async () => (await serverWhenReady()).transcribe(pcm, language));
      queue = run.catch(() => {});
      return run.finally(() => {
        inFlight--;
        if (awake) armIdle();
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(idleTimer);
      // Aborting SIGTERMs a server that is starting, in this same tick, so an app that quits right after calling this cannot orphan it.
      controller.abort();
      const current = running;
      running = null;
      const down = current?.server.stop();
      // Requests still waiting for a server learn that there will not be one.
      for (const wakeUp of waiting) wakeUp();
      waiting.clear();
      await chain;
      await down;
    },
  };
}
