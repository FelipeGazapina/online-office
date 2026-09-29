import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VOICE_SCHEME } from '../../shared/voice.ts';
import { PCM_WORKLET_SOURCE } from './worklet.ts';

type Asset = { type: string; read: () => Promise<Uint8Array | string> };

const JS = 'text/javascript';

// The page fetches these through the office-voice protocol. Only the names listed here are served, so a request
// cannot reach any other file. `appDir` is the folder that holds node_modules.
export function voiceAssets(appDir: string): (url: string) => Promise<Response> {
  const vad = join(appDir, 'node_modules/@ricky0123/vad-web/dist');
  const ort = join(appDir, 'node_modules/onnxruntime-web/dist');
  const file = (dir: string, name: string, type: string): [string, Asset] => [name, { type, read: () => readFile(join(dir, name)) }];
  const assets = new Map<string, Asset>([
    ['pcm-worklet.js', { type: JS, read: async () => PCM_WORKLET_SOURCE }],
    file(vad, 'vad.worklet.bundle.min.js', JS),
    file(vad, 'silero_vad_v5.onnx', 'application/octet-stream'),
    file(ort, 'ort-wasm-simd-threaded.mjs', JS),
    file(ort, 'ort-wasm-simd-threaded.wasm', 'application/wasm'),
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
