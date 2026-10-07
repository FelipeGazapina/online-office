// The material of the lit screens on the desks. A screen is the dark editor texture it always was, except the one a terminal is drawn
// on: there the colour comes from the terminal atlas (scene/terminalAtlas.ts), from the rectangle that employee's tile has.
import { MeshBasicMaterial, type Texture } from 'three';

const VERTEX_PARS = `
attribute vec4 iRect;
attribute float aTerm;
varying vec4 vTermRect;
varying float vTermOn;
varying vec2 vTermUv;
`;

const FRAGMENT_PARS = `
uniform sampler2D termMap;
varying vec4 vTermRect;
varying float vTermOn;
varying vec2 vTermUv;
`;

// A screen with no tile has an empty rectangle and keeps the editor texture.
const MAP_FRAGMENT = `
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	if ( vTermOn > 0.5 && vTermRect.z > 0.0 ) {
		sampledDiffuseColor = texture2D( termMap, vec2( vTermRect.x + vTermUv.x * vTermRect.z, vTermRect.y + ( 1.0 - vTermUv.y ) * vTermRect.w ) );
	}
	diffuseColor *= sampledDiffuseColor;
#endif
`;

// The instance colour tints the editor texture by what the sitter is doing. A terminal says that with its own words.
const COLOR_FRAGMENT = `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	diffuseColor.rgb *= mix( vColor.rgb, vec3( 1.0 ), ( vTermOn > 0.5 && vTermRect.z > 0.0 ) ? 1.0 : 0.0 );
#endif
`;

export const termMap: { value: Texture | null } = { value: null };

export function screenMaterial(editor: Texture): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ map: editor, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.termMap = termMap;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTermRect = iRect;\n\tvTermOn = aTerm;\n\tvTermUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', MAP_FRAGMENT)
      .replace('#include <color_fragment>', COLOR_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'terminal-screen';
  return m;
}
