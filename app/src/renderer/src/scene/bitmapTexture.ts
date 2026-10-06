import { NoColorSpace, SRGBColorSpace, Texture } from 'three';

/** A packaged page loads from file://, where fetch refuses file URLs but XMLHttpRequest reads them. */
export const readFile = (url: string) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response ? resolve(x.response as ArrayBuffer) : reject(new Error(`Empty file ${url}`)));
    x.onerror = () => reject(new Error(`Could not read ${url}`));
    x.send();
  });

const decoding: Promise<Texture>[] = [];

/** Every bitmap texture made so far, once each has its image. A texture draws as the empty default until then. */
export const bitmapTexturesReady = () => Promise.all(decoding);

/**
 * A texture whose image is decoded off the main thread. An image element is decoded again inside every texSubImage2D, which
 * put 170 to 230 ms of the first draw on the main thread; an ImageBitmap arrives decoded and uploads in about a quarter of
 * the time. The texture draws as the empty default until its bitmap is ready, the same as one from TextureLoader.
 */
export function bitmapTexture(url: string, { srgb, flipY }: { srgb: boolean; flipY: boolean }): Texture {
  const texture = new Texture();
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  // An ImageBitmap ignores UNPACK_FLIP_Y_WEBGL, so the orientation is fixed when the bitmap is made.
  texture.flipY = false;
  decoding.push(
    readFile(url)
      .then((bytes) => createImageBitmap(new Blob([bytes]), { imageOrientation: flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then((bitmap) => {
        texture.image = bitmap;
        texture.needsUpdate = true;
        return texture;
      }),
  );
  return texture;
}
