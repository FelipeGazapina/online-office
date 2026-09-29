import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { VoiceQuality } from '../../shared/voice.ts';

export type ModelSpec = { file: string; url: string };
export type ModelSet = { quality: Record<VoiceQuality, ModelSpec>; vad: ModelSpec };
export type Progress = { received: number; total: number };

const WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const MODELS: ModelSet = {
  quality: {
    fast: { file: 'ggml-small-q5_1.bin', url: `${WHISPER}/ggml-small-q5_1.bin` },
    accurate: { file: 'ggml-large-v3-turbo-q5_0.bin', url: `${WHISPER}/ggml-large-v3-turbo-q5_0.bin` },
  },
  vad: { file: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' },
};

const PROGRESS_EVERY_MS = 200;

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

// Node's fetch reports every network failure as "fetch failed" and keeps the cause (ENOTFOUND, ECONNREFUSED) beside it.
// The cause often lists every address it tried in parentheses, which does not fit on the HUD chip.
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const reason = err.cause instanceof Error ? err.cause.message : err.message;
  return reason.replace(/ \(.*$/, '');
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// The 302 that Hugging Face answers a HEAD with carries the file's size, its SHA-256 (as the etag) and the CDN URL.
// The CDN's own response carries none of them.
async function describe(spec: ModelSpec, signal?: AbortSignal) {
  const head = await fetch(spec.url, { method: 'HEAD', redirect: 'manual', signal });
  const size = Number(head.headers.get('x-linked-size'));
  const sha256 = head.headers.get('x-linked-etag')?.replaceAll('"', '');
  const url = head.headers.get('location');
  if (!size || !sha256 || !url) throw new Error(`Hugging Face did not describe the file (HTTP ${head.status})`);
  return { size, sha256, url };
}

async function fetchInto(o: { url: string; part: string; size: number; onProgress?: (p: Progress) => void; signal?: AbortSignal }) {
  let have = (await sizeOf(o.part)) ?? 0;
  if (have > o.size) {
    await unlink(o.part);
    have = 0;
  }
  if (have === o.size) return;
  const res = await fetch(o.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: o.signal });
  // A server that ignores Range answers 200 with the whole file, so the partial one is overwritten.
  const resumed = have > 0 && res.status === 206;
  if (!res.body || !(resumed || res.status === 200)) throw new Error(`unexpected HTTP ${res.status} (resuming from ${have} bytes)`);

  let received = resumed ? have : 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastReport >= PROGRESS_EVERY_MS) {
      lastReport = now;
      o.onProgress?.({ received, total: o.size });
    }
  });
  await pipeline(body, createWriteStream(o.part, { flags: resumed ? 'a' : 'w' }));
  o.onProgress?.({ received, total: o.size });
}

async function download(o: { spec: ModelSpec; dest: string; onProgress?: (p: Progress) => void; signal?: AbortSignal }) {
  const { size, sha256, url } = await describe(o.spec, o.signal);
  const part = `${o.dest}.part`;
  await fetchInto({ url, part, size, onProgress: o.onProgress, signal: o.signal });
  // A short file is a dropped connection, and the next call resumes it. Only a full-size mismatch is corruption.
  const got = await sizeOf(part);
  if (got !== size) throw new Error(`the connection stopped at ${got ?? 0} of ${size} bytes`);
  if ((await sha256Of(part)) !== sha256) {
    await unlink(part);
    throw new Error('the file did not match its SHA-256, so the partial file was deleted');
  }
  await rename(part, o.dest);
}

// Puts the model in `dir` and returns its path. Safe to call again after a crash, a cancel or a dropped connection.
export async function ensureModel(o: { spec: ModelSpec; dir: string; onProgress?: (p: Progress) => void; signal?: AbortSignal }): Promise<string> {
  await mkdir(o.dir, { recursive: true });
  const dest = join(o.dir, o.spec.file);
  // Nothing reaches `dest` until its hash matched, so a file there is whole, and voice keeps working offline.
  if ((await sizeOf(dest)) !== null) return dest;
  try {
    await download({ spec: o.spec, dest, onProgress: o.onProgress, signal: o.signal });
  } catch (err) {
    throw o.signal?.aborted ? err : new Error(`Could not download ${o.spec.file}: ${reasonOf(err)}`);
  }
  return dest;
}
