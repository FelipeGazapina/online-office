import { NoColorSpace, SRGBColorSpace, Texture } from 'three';

/**
 * A packaged page loads from file://, where fetch refuses file URLs but XMLHttpRequest reads them. A file under the bundler's inline
 * limit (4 KiB; a small map after a shrink) arrives as a base64 data URL, which XMLHttpRequest refuses here and is decoded by hand.
 */
export const readFile = (url: string) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const data = /^data:[^,]*;base64,(.*)$/s.exec(url);
    if (data) return resolve(Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0)).buffer);
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response ? resolve(x.response as ArrayBuffer) : reject(new Error(`Empty file ${url}`)));
    x.onerror = () => reject(new Error(`Could not read ${url.slice(0, 80)}`));
    x.send();
  });

const decoding: Promise<Texture>[] = [];
const sources = new Map<Texture, { url: string; flipY: boolean }>();

/** Every bitmap texture made so far, once each has its image. A texture draws as the empty default until then. */
export const bitmapTexturesReady = () => Promise.all(decoding);

const decode = (url: string, flipY: boolean) =>
  readFile(url).then((bytes) => createImageBitmap(new Blob([bytes]), { imageOrientation: flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));

/** Decodes the file again and hands it to the texture, which uploads it on the next draw. */
const give = (texture: Texture, url: string, flipY: boolean) =>
  decode(url, flipY).then((bitmap) => {
    (texture.image as Partial<ImageBitmap> | null)?.close?.();
    texture.image = bitmap;
    texture.needsUpdate = true;
    return texture;
  });

/**
 * A texture whose image is decoded off the main thread. An image element is decoded again inside every texSubImage2D, which
 * put 170 to 230 ms of the first draw on the main thread; an ImageBitmap arrives decoded and uploads in about a quarter of
 * the time. The texture draws as the empty default until its bitmap is ready, the same as one from TextureLoader.
 *
 * three calls `onUpdate` once the pixels are on the GPU. The decoded bitmap is then a second copy of the whole map in the
 * renderer process (4 MiB for a 1024 px map, 174 MiB for all of them), so it is closed there. Nothing uploads a map twice
 * but a lost GL context, and `reloadBitmapTextures` decodes the files again for that.
 */
export function bitmapTexture(url: string, { srgb, flipY }: { srgb: boolean; flipY: boolean }): Texture {
  const texture = new Texture();
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  // An ImageBitmap ignores UNPACK_FLIP_Y_WEBGL, so the orientation is fixed when the bitmap is made.
  texture.flipY = false;
  texture.onUpdate = () => {
    const bitmap = texture.image as ImageBitmap;
    // What is left says how big the map is (the memory probe reads it) and nothing more.
    texture.image = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
  };
  sources.set(texture, { url, flipY });
  decoding.push(give(texture, url, flipY));
  return texture;
}

/**
 * The GL context was lost: the GPU copies are gone and the renderer will upload again when it is restored. Until the files
 * are decoded again each texture is back to what a new one is, drawn as the empty default and never uploaded.
 */
export function reloadBitmapTextures() {
  for (const [texture, { url, flipY }] of sources) {
    texture.version = 0;
    void give(texture, url, flipY);
  }
}
