// Catalog thumbnails: every furniture def drawn once from its real model on a scratch canvas, then kept as images. One
// extra WebGL context lives for a few milliseconds on the first look at the catalog and is released at once.
import { useEffect, useState } from 'react';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { ITEM_DEFS } from '../../../../shared/space/index.ts';
import { DEFAULT_TINT, modelOf } from '../../scene/building/models.ts';

const SIZE = 192;
const cache = new Map<string, string>();
let rendering: Promise<void> | null = null;

function renderAll(): void {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  const scene = new Scene();
  scene.add(new HemisphereLight('#ffffff', '#b9a98f', 1.5), new AmbientLight('#ffffff', 0.55));
  const sun = new DirectionalLight('#fff4e0', 2.3);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const camera = new PerspectiveCamera(26, 1, 0.1, 100);
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const mesh = new Mesh(undefined, material);
  scene.add(mesh);
  for (const def of Object.keys(ITEM_DEFS)) {
    const geo = modelOf(def);
    mesh.geometry = geo;
    material.color = new Color(DEFAULT_TINT[def] ?? 0xffffff);
    geo.computeBoundingBox();
    const sphere = geo.boundingBox!.getBoundingSphere(new Sphere());
    const dir = new Vector3(1, 0.85, 1.25).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.02);
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    cache.set(def, canvas.toDataURL('image/png'));
  }
  renderer.dispose();
  renderer.forceContextLoss();
}

/** Image URL by def id, empty until the first render has run. */
export function useThumbs(): ReadonlyMap<string, string> {
  const [, bump] = useState(0);
  useEffect(() => {
    if (cache.size) return;
    rendering ??= new Promise((resolve) => {
      requestAnimationFrame(() => {
        renderAll();
        resolve();
      });
    });
    void rendering.then(() => bump((n) => n + 1));
  }, []);
  return cache;
}
