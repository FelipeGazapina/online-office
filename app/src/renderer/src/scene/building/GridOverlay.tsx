// The tile grid of the build plane: a line on every meter and a dashed one on every half meter, brightest around the
// cursor and gone a few tiles away, so the whole lot never turns into graph paper.
import { useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import { DoubleSide, ShaderMaterial, Vector2 } from 'three';
import { STORY_H } from '../../../../shared/space/index.ts';
import { draft } from '../../hud/build/state.ts';
import { useStore } from '../../store.ts';

const RADIUS = 14;
const MARGIN = 3;

const vertex = /* glsl */ `
varying vec2 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const fragment = /* glsl */ `
varying vec2 vW;
uniform vec2 uCursor;
uniform float uRadius;
float line(float v, float px) {
  float d = abs(fract(v + 0.5) - 0.5);
  float w = fwidth(v) * px;
  return 1.0 - smoothstep(w * 0.5, w * 1.5, d);
}
void main() {
  float tile = max(line(vW.x, 1.0), line(vW.y, 1.0));
  float tileHalo = max(line(vW.x, 3.2), line(vW.y, 3.2));
  float hx = line(vW.x + 0.5, 0.9) * step(0.5, fract(vW.y * 4.0));
  float hz = line(vW.y + 0.5, 0.9) * step(0.5, fract(vW.x * 4.0));
  float half = max(hx, hz);
  float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, distance(vW, uCursor));
  float core = max(tile, half * 0.55);
  float a = max(core * 0.95, tileHalo * 0.22) * fade;
  vec3 col = mix(vec3(0.09, 0.1, 0.18), vec3(1.0), core);
  gl_FragColor = vec4(col, a);
}`;

export function GridOverlay() {
  const lot = useStore((s) => s.building?.lot);
  const level = useStore((s) => s.build?.level ?? 0);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: { uCursor: { value: new Vector2(0, 0) }, uRadius: { value: RADIUS } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [],
  );
  useFrame(() => {
    material.uniforms.uCursor.value.set(draft.cursor.x, draft.cursor.z);
  });
  if (!lot) return null;
  return (
    <mesh position={[lot.x0 + lot.w / 2, level * STORY_H + 0.03, lot.z0 + lot.h / 2]} rotation-x={-Math.PI / 2} material={material} renderOrder={5}>
      <planeGeometry args={[lot.w + MARGIN * 2, lot.h + MARGIN * 2]} />
    </mesh>
  );
}
