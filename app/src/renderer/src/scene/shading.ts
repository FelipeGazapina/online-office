import type { MeshStandardMaterial } from 'three';
import { STORY_H } from '../../../shared/space/index.ts';

// Cheap material depth without extra draw calls: every shader sees the fragment's world position and adds grain,
// mottling and a contact-darkening gradient where surfaces meet the floor and ceiling. Walls also get a wainscot band.
export type Surface = 'wall' | 'furniture' | 'floor';

const GLSL = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
`;

const BODY: Record<Surface, string> = {
  wall: /* glsl */ `
    float y = mod(vWPos.y + 0.01, ${STORY_H.toFixed(2)});
    vec2 uvw = abs(vNorm.x) > 0.5 ? vWPos.zy : vWPos.xy;
    float grain = vnoise(uvw * 9.0) * 0.5 + vnoise(uvw * 2.2) * 0.5;
    diffuseColor.rgb *= 0.9 + 0.2 * grain;
    float wain = 1.0 - smoothstep(0.98, 1.0, y);
    diffuseColor.rgb *= mix(1.0, 0.8, wain);
    float rail = smoothstep(0.96, 0.98, y) * (1.0 - smoothstep(1.02, 1.04, y));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.94, 0.9), rail * 0.8);
    float skirt = 1.0 - smoothstep(0.0, 0.14, y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.9, 0.84), skirt * 0.55);
    diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.0, 0.7, y)) * mix(0.82, 1.0, 1.0 - smoothstep(${(STORY_H - 0.5).toFixed(2)}, ${STORY_H.toFixed(2)}, y));
  `,
  furniture: /* glsl */ `
    float y = vWPos.y - floor((vWPos.y + 0.05) / ${STORY_H.toFixed(2)}) * ${STORY_H.toFixed(2)};
    float grain = vnoise(vWPos.xz * 14.0 + vWPos.y * 3.0) * 0.6 + vnoise(vWPos.xz * 3.0) * 0.4;
    diffuseColor.rgb *= 0.92 + 0.16 * grain;
    diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 0.35, y));
  `,
  floor: /* glsl */ `
    float grain = vnoise(vWPos.xz * 22.0) * 0.5 + vnoise(vWPos.xz * 4.0) * 0.5;
    diffuseColor.rgb *= 0.92 + 0.14 * grain;
  `,
};

export function detail<M extends MeshStandardMaterial>(material: M, surface: Surface): M {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vNorm;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 wp_ = vec4(transformed, 1.0);
        vec3 wn_ = objectNormal;
        #ifdef USE_INSTANCING
          wp_ = instanceMatrix * wp_;
          wn_ = mat3(instanceMatrix) * wn_;
        #endif
        vWPos = (modelMatrix * wp_).xyz;
        vNorm = normalize(mat3(modelMatrix) * wn_);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vNorm;\n${GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BODY[surface]}`);
  };
  material.customProgramCacheKey = () => `detail-${surface}`;
  return material;
}
