import type { Camera, Scene, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
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

// A linked program still makes the main thread ask the GPU for its uniforms and attributes the first time it is used, one query
// at a time (30 to 70 ms for the office's programs). Asking now, a few at a time, leaves the first draw nothing to ask.
async function linked(gl: WebGLRenderer) {
  while (!allLinked(gl)) await sleep(8);
  await inSlices(gl.info.programs ?? [], (program) => {
    program.getUniforms();
    program.getAttributes();
  });
}

/**
 * Starts linking every program `scene` needs and resolves when the GPU has linked every program the renderer holds. Each top
 * level object is compiled in a task of its own, since creating a program costs the main thread about a millisecond. With a
 * `target` the programs are the ones for drawing into it, which differ from the screen's: a target is linear and not tone mapped.
 */
export async function compileScene(gl: WebGLRenderer, scene: Scene, camera: Camera, target: WebGLRenderTarget | null = null) {
  for (const child of scene.children) {
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    gl.compile(child, camera, scene);
    gl.setRenderTarget(previous);
    await yieldToBrowser();
  }
  await linked(gl);
}

/** Runs `each` over `items` a few milliseconds at a time, so no task spends long on it. */
async function inSlices<T>(items: readonly T[], each: (item: T) => void, sliceMs = 6) {
  let sliceStart = performance.now();
  for (const item of items) {
    each(item);
    if (performance.now() - sliceStart < sliceMs) continue;
    await yieldToBrowser();
    sliceStart = performance.now();
  }
}

/** Gets everything the first draw would wait for out of its way: linked programs and uploaded textures. */
export async function warmFirstDraw(gl: WebGLRenderer, scene: Scene, camera: Camera) {
  performance.mark('office-compile-start');
  await compileScene(gl, scene, camera);
  performance.mark('office-programs-linked', { detail: { programs: gl.info.programs?.length } });
  const textures = await bitmapTexturesReady();
  await inSlices(textures, (texture) => gl.initTexture(texture));
  performance.mark('office-textures-uploaded');
}
