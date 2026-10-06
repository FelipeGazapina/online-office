import type { MeshStandardMaterial, Texture } from 'three';
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

// Surface relief, drawn with no UVs: a height from the world position, turned into a tilt of the normal with the screen
// derivatives. Plaster is fine and mottled; furniture gets a laminate grain plus a woven fabric pattern. The relief fades out
// when a pixel covers a centimetre or more, so far surfaces stay calm instead of shimmering.
const RELIEF: Partial<Record<Surface, { height: string; strength: string; rough: string }>> = {
  furniture: {
    height: 'vnoise(vec2(vWPos.x + vWPos.z, vWPos.y) * vec2(70.0, 9.0)) * 0.5 + (sin(vWPos.x * 420.0) * sin(vWPos.z * 420.0 + vWPos.y * 420.0)) * 0.1 + vnoise(vWPos.xz * 30.0) * 0.4',
    strength: '0.7',
    rough: 'vnoise(vWPos.xz * 9.0 + vWPos.yy * 6.0)',
  },
};

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

/** The textures the wall shader samples, projected in world space so a wall of any length and every instanced segment line up without UVs. `mean` is the colour map's average, divided out so paint keeps its own hue. */
export type WallTextures = { map: Texture; normalMap: Texture; armMap: Texture; mean: [number, number, number]; metresPerRepeat: number };

const WALL_PARS = /* glsl */ `
uniform sampler2D uWallMap;
uniform sampler2D uWallNor;
uniform sampler2D uWallArm;
uniform vec3 uWallMean;
uniform float uWallScale;
vec3 wallAxis;
vec2 wallUv;
`;
const WALL_UV = /* glsl */ `
    wallAxis = abs(vNorm.x) > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    wallUv = (abs(vNorm.y) > 0.7 ? vWPos.xz : vec2(dot(vWPos, wallAxis), vWPos.y)) * uWallScale;
`;
const WALL_COLOR = /* glsl */ `
    diffuseColor.rgb *= texture2D(uWallMap, wallUv).rgb / uWallMean * mix(1.0, texture2D(uWallArm, wallUv).r, 0.75);
`;
const WALL_ROUGH = /* glsl */ `roughnessFactor = clamp(roughnessFactor * (0.55 + 0.7 * texture2D(uWallArm, wallUv).g), 0.05, 1.0);`;
const WALL_NORMAL = /* glsl */ `
  {
    vec3 tn = texture2D(uWallNor, wallUv).xyz * 2.0 - 1.0;
    vec3 n = normalize(vNorm);
    vec3 tu = abs(n.y) > 0.7 ? vec3(1.0, 0.0, 0.0) : wallAxis;
    vec3 tv = abs(n.y) > 0.7 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 wn = normalize(n + (tu * tn.x + tv * tn.y) * 0.9);
    normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz) * faceDirection;
  }
`;

export function detail<M extends MeshStandardMaterial>(material: M, surface: Surface, wallTextures?: WallTextures): M {
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
      .replace('#include <color_fragment>', `#include <color_fragment>\n${wallTextures ? WALL_UV + WALL_COLOR : ''}${BODY[surface]}`);
    if (wallTextures) {
      shader.uniforms.uWallMap = { value: wallTextures.map };
      shader.uniforms.uWallNor = { value: wallTextures.normalMap };
      shader.uniforms.uWallArm = { value: wallTextures.armMap };
      shader.uniforms.uWallMean = { value: wallTextures.mean };
      shader.uniforms.uWallScale = { value: 1 / wallTextures.metresPerRepeat };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${WALL_PARS}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${WALL_ROUGH}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${WALL_NORMAL}`);
    }
    const relief = RELIEF[surface];
    if (relief) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * (0.82 + 0.3 * (${relief.rough})), 0.05, 1.0);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float hh = ${relief.height};
            float footprint = length(dFdx(vWPos)) + length(dFdy(vWPos));
            float fade = 1.0 - smoothstep(0.004, 0.014, footprint);
            vec2 dh = clamp(vec2(dFdx(hh), dFdy(hh)) * ${relief.strength} * fade, -0.6, 0.6);
            vec3 sp = -vViewPosition;
            vec3 sx = normalize(dFdx(sp));
            vec3 sy = normalize(dFdy(sp));
            vec3 r1 = cross(sy, normal);
            vec3 r2 = cross(normal, sx);
            float det = dot(sx, r1) * faceDirection;
            normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
          }`,
        );
    }
  };
  material.customProgramCacheKey = () => `detail-${surface}${wallTextures ? '-tex' : ''}`;
  return material;
}
