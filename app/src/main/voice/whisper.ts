import { basename } from 'node:path';
import type { Language, VoiceEngine, VoiceQuality } from '../../shared/voice.ts';
import { findBinary } from './binary.ts';
import { ensureModel, MODELS, type ModelSet, type ModelSpec } from './models.ts';
import { startServer, type WhisperServer } from './server.ts';

export type WhisperOptions = {
  // Where the models live. The pid file names the server of one app profile, so two profiles never kill each other's.
  cacheDir: string;
  pidFile: string;
  onEngine?: (engine: VoiceEngine) => void;
  // Tests replace these to run against a stand-in server or a local model host, or under another shell.
  locate?: () => Promise<string | null>;
  models?: ModelSet;
  shell?: string;
};

export type Whisper = {
  engine(): VoiceEngine;
  // Starts the engine on the model for this quality, or moves it there. Resolves once the engine is ready or has failed.
  use(quality: VoiceQuality): Promise<void>;
  // Looks for the binary again, then retries.
  recheck(): Promise<void>;
  // One request at a time. Waits while the engine starts, and rejects when it cannot serve.
  transcribe(pcm: Uint8Array, language: Language): Promise<string>;
  stop(): Promise<void>;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createWhisper(o: WhisperOptions): Whisper {
  const models = o.models ?? MODELS;
  const locate = o.locate ?? (() => findBinary('whisper-server'));
  // Looked up once, at startup. A missing binary costs a second in the login shell, so it is not asked per call.
  let binary = locate();
  let engine: VoiceEngine = { kind: 'starting' };
  let server: WhisperServer | null = null;
  let quality: VoiceQuality = 'fast';
  let generation = 0;
  let stopped = false;
  let controller = new AbortController();
  let attempt: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const waiting = new Set<() => void>();

  function set(next: VoiceEngine) {
    if (JSON.stringify(next) === JSON.stringify(engine)) return;
    engine = next;
    o.onEngine?.(next);
    for (const wake of waiting) wake();
    waiting.clear();
  }

  function use(next: VoiceQuality): Promise<void> {
    if (stopped) return Promise.resolve();
    const running = engine.kind === 'starting' || engine.kind === 'downloading' || engine.kind === 'ready';
    if (generation > 0 && running && next === quality) return attempt;

    quality = next;
    const mine = ++generation;
    controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    const previous = attempt;
    attempt = (async () => {
      // One attempt at a time, so two servers never run at once and the pid file has one owner.
      await previous;
      if (mine !== generation) return;
      const old = server;
      server = null;
      await old?.stop();
      set({ kind: 'starting' });
      try {
        const path = await binary;
        if (!path) {
          set({ kind: 'missing_binary' });
          return;
        }
        const fetchModel = (spec: ModelSpec) =>
          ensureModel({
            spec,
            dir: o.cacheDir,
            signal,
            onProgress: ({ received, total }) => set({ kind: 'downloading', file: spec.file, received, total }),
          });
        const vadModel = await fetchModel(models.vad);
        const model = await fetchModel(models.quality[next]);
        set({ kind: 'starting' });
        const started = await startServer({ binary: path, model, vadModel, pidFile: o.pidFile, signal, shell: o.shell });
        if (mine !== generation) {
          await started.stop();
          return;
        }
        server = started;
        void started.exited.then((exit) => {
          if (server !== started || exit.stopped) return;
          server = null;
          set({ kind: 'error', message: exit.reason });
        });
        set({ kind: 'ready', model: basename(model) });
      } catch (err) {
        if (!signal.aborted) set({ kind: 'error', message: message(err) });
      }
    })();
    return attempt;
  }

  async function serverWhenReady(): Promise<WhisperServer> {
    for (;;) {
      if (stopped) throw new Error('The voice engine has stopped');
      switch (engine.kind) {
        case 'ready':
          if (server) return server;
          throw new Error('The voice engine has no server');
        case 'starting':
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
    use,
    recheck() {
      binary = locate();
      return use(quality);
    },
    transcribe(pcm, language) {
      const run = queue.then(async () => (await serverWhenReady()).transcribe(pcm, language));
      queue = run.catch(() => {});
      return run;
    },
    async stop() {
      stopped = true;
      generation++;
      // Aborting SIGTERMs this attempt's server in the same tick, so an app that quits right after calling this cannot orphan it.
      controller.abort();
      const current = server;
      server = null;
      await attempt;
      await current?.stop();
    },
  };
}
