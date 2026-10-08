// Test-only: where the renderer's graphics memory sits, for the RAM harness (verify/e2e-ram.mjs). Installed as `__office.memory()` with the
// other debug hooks. It reads three.js and the DOM and changes nothing.
//
// Bytes are estimates from sizes and formats (width x height x bytes per pixel, a third more for mipmaps, six faces for a cube), not what the
// driver really allocates, but they rank the owners and move with every change that matters. The GPU process's footprint is the check on them.
import { _roots } from '@react-three/fiber';
import {
  BufferGeometry,
  CompressedTexture,
  HalfFloatType,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RGFormat,
  RGBAFormat,
  UnsignedByteType,
  UnsignedShort4444Type,
  UnsignedShort5551Type,
  UnsignedShortType,
  type InstancedMesh,
  type Light,
  type LightShadow,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
  type WebGLRenderTarget,
} from 'three';

const MIB = 1024 * 1024;
const r2 = (n: number) => +n.toFixed(2);

type Dim = { width: number; height: number; depth: number };

function dims(t: Texture): Dim {
  const image = (t.image ?? t.source?.data) as { width?: number; height?: number; depth?: number; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number } | { width?: number; height?: number }[] | null;
  const one = Array.isArray(image) ? image[0] : image;
  if (!one) return { width: 0, height: 0, depth: 1 };
  const w = (one as { width?: number }).width || (one as { naturalWidth?: number }).naturalWidth || (one as { videoWidth?: number }).videoWidth || 0;
  const h = (one as { height?: number }).height || (one as { naturalHeight?: number }).naturalHeight || (one as { videoHeight?: number }).videoHeight || 0;
  const d = (t as unknown as { isCubeTexture?: boolean }).isCubeTexture ? 6 : ((one as { depth?: number }).depth ?? 1);
  return { width: w, height: h, depth: d };
}

function bytesPerPixel(t: Texture): number {
  const channels = t.format === RedFormat ? 1 : t.format === RGFormat ? 2 : 4;
  if (t.type === HalfFloatType) return 2 * (t.format === RGBAFormat ? 4 : channels);
  if (t.type === FloatType) return 4 * (t.format === RGBAFormat ? 4 : channels);
  if (t.type === UnsignedShort4444Type || t.type === UnsignedShort5551Type || t.type === UnsignedShortType) return 2;
  if (t.type === UnsignedByteType) return channels === 1 ? 1 : channels === 2 ? 2 : 4;
  return 4;
}

const usesMips = (t: Texture) => t.generateMipmaps && t.minFilter !== LinearFilter && t.minFilter !== NearestFilter;

function textureBytes(t: Texture): number {
  if ((t as CompressedTexture).isCompressedTexture) {
    return (t as CompressedTexture).mipmaps?.reduce((sum, m) => sum + ((m.data as ArrayBufferView | undefined)?.byteLength ?? 0), 0) ?? 0;
  }
  const { width, height, depth } = dims(t);
  const base = width * height * depth * bytesPerPixel(t);
  return Math.round(usesMips(t) ? (base * 4) / 3 : base);
}

function renderTargetBytes(rt: WebGLRenderTarget): number {
  const { width, height, depth } = rt;
  const colors = Array.isArray((rt as unknown as { textures?: Texture[] }).textures) ? (rt as unknown as { textures: Texture[] }).textures.length : 1;
  const samples = rt.samples || 1;
  const px = width * height * depth;
  const color = rt.texture ? px * bytesPerPixel(rt.texture) * colors * (usesMips(rt.texture) ? 4 / 3 : 1) : 0;
  const depthBuffer = rt.depthBuffer || rt.depthTexture ? px * 4 : 0;
  return Math.round(color * (samples > 1 ? 1 + samples : 1) + depthBuffer * (samples > 1 ? samples : 1));
}

const TEXTURE_KEYS = ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'envMap', 'lightMap', 'displacementMap', 'specularMap', 'gradientMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap', 'thicknessMap'];

type TexRow = { owner: string; src: string; kind: string; width: number; height: number; depth: number; format: string; mips: boolean; uploaded: boolean; MiB: number; users: number };

const nameOf = (o: Object3D) => o.name || (o.userData?.probe as string | undefined) || o.type;

export function memoryReport() {
  const root = _roots.values().next().value;
  if (!root) throw new Error('no canvas');
  const { gl, scene, size } = root.store.getState();
  const info = gl.info;
  const props = (gl as unknown as { properties: { has(o: object): boolean } }).properties;
  const ctx = gl.getContext() as WebGL2RenderingContext;

  // Textures reachable from the scene, one row per image source (three shares one GPU texture between textures with the same source).
  const bySource = new Map<string, TexRow>();
  const addTexture = (t: Texture | null | undefined, owner: string) => {
    if (!t || !(t as { isTexture?: boolean }).isTexture) return;
    const key = t.source?.uuid ?? t.uuid;
    const seen = bySource.get(key);
    if (seen) {
      seen.users++;
      return;
    }
    const { width, height, depth } = dims(t);
    // The file a texture was loaded from, when it still says (an image element does; a glTF-embedded or drawn one does not).
    const data = (t.source?.data ?? t.image) as { src?: unknown; currentSrc?: unknown } | null;
    const url = typeof data?.currentSrc === 'string' && data.currentSrc ? data.currentSrc : typeof data?.src === 'string' ? data.src : '';
    bySource.set(key, {
      owner,
      src: url.startsWith('data:') ? 'data-uri' : url.slice(url.lastIndexOf('/') + 1).slice(0, 60) || t.name,
      kind: (t as CompressedTexture).isCompressedTexture ? 'compressed' : (t as unknown as { isCubeTexture?: boolean }).isCubeTexture ? 'cube' : (t as unknown as { isDataTexture?: boolean }).isDataTexture ? 'data' : (t as unknown as { isCanvasTexture?: boolean }).isCanvasTexture ? 'canvas' : (t as unknown as { isDepthTexture?: boolean }).isDepthTexture ? 'depth' : 'image',
      width,
      height,
      depth,
      format: `${t.format}/${t.type}`,
      mips: usesMips(t),
      uploaded: props.has(t),
      MiB: r2(textureBytes(t) / MIB),
      users: 1,
    });
  };

  const geometries = new Map<string, { owner: string; MiB: number; vertices: number; instances: number }>();
  const materials = new Set<Material>();
  const targets: { owner: string; width: number; height: number; MiB: number }[] = [];
  const counts = { objects: 0, meshes: 0, instancedMeshes: 0, instances: 0, lights: 0, shadowLights: 0 };
  const shadows: { light: string; mapSize: string; allocated: boolean; MiB: number }[] = [];

  scene.traverse((o: Object3D) => {
    counts.objects++;
    const mesh = o as Mesh;
    if ((o as Light).isLight) {
      counts.lights++;
      const light = o as Light & { shadow?: LightShadow };
      if (light.castShadow && light.shadow) {
        counts.shadowLights++;
        const map = light.shadow.map as WebGLRenderTarget | null;
        const bytes = map ? renderTargetBytes(map) : 0;
        shadows.push({ light: `${nameOf(o)} (${o.type})`, mapSize: `${light.shadow.mapSize.x}x${light.shadow.mapSize.y}`, allocated: !!map, MiB: r2(bytes / MIB) });
        if (map) targets.push({ owner: `shadow map of ${nameOf(o)}`, width: map.width, height: map.height, MiB: r2(bytes / MIB) });
      }
    }
    if (!mesh.isMesh && !(o as { isPoints?: boolean }).isPoints && !(o as { isLine?: boolean }).isLine) return;
    counts.meshes++;
    const geometry = (mesh as { geometry?: BufferGeometry }).geometry;
    const inst = o as InstancedMesh;
    if (inst.isInstancedMesh) {
      counts.instancedMeshes++;
      counts.instances += inst.count;
    }
    if (geometry && !geometries.has(geometry.uuid)) {
      let bytes = 0;
      for (const a of Object.values(geometry.attributes)) bytes += (a as { array?: ArrayBufferView }).array?.byteLength ?? 0;
      bytes += geometry.index?.array.byteLength ?? 0;
      geometries.set(geometry.uuid, { owner: geometry.name || nameOf(o), MiB: bytes / MIB, vertices: geometry.attributes.position?.count ?? 0, instances: inst.isInstancedMesh ? inst.count : 0 });
    }
    if (inst.isInstancedMesh) {
      const g = geometry ? geometries.get(geometry.uuid) : undefined;
      if (g) g.MiB += ((inst.instanceMatrix?.array.byteLength ?? 0) + (inst.instanceColor?.array.byteLength ?? 0)) / MIB;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      materials.add(m);
      for (const key of TEXTURE_KEYS) addTexture((m as unknown as Record<string, Texture | null>)[key], `${m.name || m.type}.${key} on ${nameOf(o)}`);
    }
  });
  if (scene.environment) addTexture(scene.environment, 'scene.environment');
  if (scene.background && (scene.background as Texture).isTexture) addTexture(scene.background as Texture, 'scene.background');
  // A PMREM environment is the texture of a render target the renderer owns; its image is the target's size.
  const environment = scene.environment ? { ...dims(scene.environment), type: scene.environment.constructor.name, mapping: scene.environment.mapping } : null;

  const textures = [...bySource.values()].sort((a, b) => b.MiB - a.MiB);
  const texTotal = textures.reduce((s, t) => s + t.MiB, 0);
  // Textures the renderer draws into (depth textures of render targets) show up with their targets, not here.
  const depthTextures = textures.filter((t) => t.kind === 'depth').length;

  // The canvas the page draws into: the drawing buffer is double the display size on a high-density display.
  const attrs = gl.getContextAttributes();
  const canvas = gl.domElement;
  const pixels = canvas.width * canvas.height;
  const msaa = attrs?.antialias ? 4 : 1;
  const drawingBuffer = { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, devicePixelRatio: window.devicePixelRatio, rendererPixelRatio: gl.getPixelRatio(), antialias: !!attrs?.antialias, alpha: !!attrs?.alpha, MiBEstimate: r2((pixels * 4 * (msaa > 1 ? 1 + msaa : 2) + pixels * 4 * msaa) / MIB) };

  const geoms = [...geometries.values()].sort((a, b) => b.MiB - a.MiB);
  const geomTotal = geoms.reduce((s, g) => s + g.MiB, 0);

  const domCanvases = [...document.querySelectorAll('canvas')].map((c) => ({ width: c.width, height: c.height, MiB: r2((c.width * c.height * 4) / MIB), cls: c.className || c.parentElement?.className || '' }));
  const maxTex = ctx.getParameter(ctx.MAX_TEXTURE_SIZE) as number;
  const renderer = (() => {
    const ext = ctx.getExtension('WEBGL_debug_renderer_info');
    return ext ? (ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : 'unknown';
  })();

  return {
    renderer,
    maxTextureSize: maxTex,
    three: { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0, calls: info.render.calls, triangles: info.render.triangles },
    canvas: { viewport: { width: size.width, height: size.height }, drawingBuffer },
    counts: { ...counts, materials: materials.size, textureSources: textures.length, geometryObjects: geoms.length },
    textures: { totalMiB: r2(texTotal), uploadedMiB: r2(textures.filter((t) => t.uploaded).reduce((s, t) => s + t.MiB, 0)), depthTextures, top: textures.slice(0, 40) },
    renderTargets: { totalMiB: r2(targets.reduce((s, t) => s + t.MiB, 0)), list: targets },
    shadows,
    environment,
    geometry: { totalMiB: r2(geomTotal), top: geoms.slice(0, 15).map((g) => ({ ...g, MiB: r2(g.MiB) })) },
    domCanvases: { count: domCanvases.length, totalMiB: r2(domCanvases.reduce((s, c) => s + c.MiB, 0)), list: domCanvases.sort((a, b) => b.MiB - a.MiB).slice(0, 12) },
    dom: { nodes: document.getElementsByTagName('*').length },
    jsHeap: (() => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return m ? { usedMiB: r2(m.usedJSHeapSize / MIB), totalMiB: r2(m.totalJSHeapSize / MIB), limitMiB: r2(m.jsHeapSizeLimit / MIB) } : null;
    })(),
  };
}

