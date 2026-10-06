import type { Camera, Object3D, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { bitmapTexturesReady } from './bitmapTexture.ts';

// WebGL links a program in the background, but the first call that reads it (a uniform lookup, a draw) waits for the link on
// the calling thread. three.js reads a program at the first draw that uses it, so the first draw of the office waited
// 280 to 540 ms for the GPU, and the cube capture of the room another 210 to 310 ms. Starting every link first and drawing
// once they are done turns that wait into time the main thread spends on other work.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Unlike setTimeout, a message is not clamped to 4 ms after a few nested calls.
const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

// Every program the renderer has asked the GPU to link. `isReady` is what WebGLRenderer.compileAsync polls; it reads the
// KHR_parallel_shader_compile completion flag without waiting, and is true at once when the driver lacks that extension.
type Linking = { isReady?: () => boolean };
const allLinked = (gl: WebGLRenderer) => (gl.info.programs ?? []).every((p) => (p as Linking).isReady?.() ?? true);

async function linked(gl: WebGLRenderer) {
  while (!allLinked(gl)) await sleep(8);
}

/** Starts linking every program `scene` needs, and resolves when the GPU has linked every program the renderer holds. */
export async function compileScene(gl: WebGLRenderer, scene: Object3D, camera: Camera) {
  performance.mark('office-compile-start');
  gl.compile(scene, camera);
  performance.mark('office-compile-started', { detail: { programs: gl.info.programs?.length } });
  await linked(gl);
  performance.mark('office-programs-linked');
}

/** The same for drawing into `target`, whose programs differ from the screen's: a target is linear and is not tone mapped. */
export function compileSceneInto(gl: WebGLRenderer, target: WebGLRenderTarget, scene: Object3D, camera: Camera): Promise<void> {
  const previous = gl.getRenderTarget();
  gl.setRenderTarget(target);
  gl.compile(scene, camera);
  gl.setRenderTarget(previous);
  return linked(gl);
}

/** Uploads textures to the GPU a few milliseconds at a time, so no task spends long on it. */
async function uploadTextures(gl: WebGLRenderer, textures: readonly Texture[], sliceMs = 6) {
  let sliceStart = performance.now();
  for (const texture of textures) {
    gl.initTexture(texture);
    if (performance.now() - sliceStart < sliceMs) continue;
    await yieldToBrowser();
    sliceStart = performance.now();
  }
}

/** Gets everything the first draw would wait for out of its way: linked programs and uploaded textures. */
export async function warmFirstDraw(gl: WebGLRenderer, scene: Object3D, camera: Camera) {
  const [textures] = await Promise.all([bitmapTexturesReady(), compileScene(gl, scene, camera)]);
  performance.mark('office-textures-decoded');
  await uploadTextures(gl, textures);
  performance.mark('office-textures-uploaded');
}
