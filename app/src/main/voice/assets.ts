import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { VOICE_SCHEME } from '../../shared/voice.ts';
import { PCM_WORKLET_SOURCE } from './worklet.ts';

type Asset = { type: string; read: () => Promise<Uint8Array | string> };

const JS = 'text/javascript';

// The page fetches these through the office-voice protocol. Only the names listed here are served, so a request cannot
// reach any other file. Each file is found by module resolution from `from`, the main bundle in the built app, so where the
// app was started from cannot matter. onnxruntime-web exports these two files and not its package.json, so its folder
// cannot be resolved and each file is resolved by itself.
export function voiceAssets(from: string | URL = import.meta.url): (url: string) => Promise<Response> {
  const require = createRequire(from);
  const packaged = (name: string, specifier: string, type: string): [string, Asset] => [name, { type, read: async () => readFile(require.resolve(specifier)) }];
  const assets = new Map<string, Asset>([
    ['pcm-worklet.js', { type: JS, read: async () => PCM_WORKLET_SOURCE }],
    packaged('vad.worklet.bundle.min.js', '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', JS),
    packaged('silero_vad_v5.onnx', '@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'application/octet-stream'),
    packaged('ort-wasm-simd-threaded.mjs', 'onnxruntime-web/ort-wasm-simd-threaded.mjs', JS),
    packaged('ort-wasm-simd-threaded.wasm', 'onnxruntime-web/ort-wasm-simd-threaded.wasm', 'application/wasm'),
  ]);

  return async (url) => {
    const { protocol, host, pathname } = new URL(url);
    const asset = protocol === `${VOICE_SCHEME}:` && host === 'assets' ? assets.get(pathname.slice(1)) : undefined;
    if (!asset) return new Response('Not found', { status: 404 });
    const body = await asset.read().catch(() => null);
    if (body === null) return new Response(`Could not read ${pathname}`, { status: 500 });
    // The page is file:// or the dev server, so every fetch of these is cross-origin.
    return new Response(body, { headers: { 'content-type': asset.type, 'access-control-allow-origin': '*' } });
  };
}
