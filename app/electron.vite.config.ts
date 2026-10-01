import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { VOICE_ORIGIN } from './src/shared/voice.ts';

// Only the built page gets a CSP: the dev server's HMR needs inline scripts and a websocket.
// Style is 'unsafe-inline' because mermaid's SVG and drei's labels carry inline styles. Voice needs the office-voice origin,
// where the worklet, the Silero model and onnxruntime-web are served, and wasm-unsafe-eval to compile onnxruntime's wasm.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${VOICE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self' https: http:",
  `connect-src 'self' ${VOICE_ORIGIN}`,
  "worker-src 'self' blob:",
].join('; ');

// Terminals inside Electron apps (T3 Code, VS Code, Cursor) export this, and electron-vite passes its env to
// the app it spawns. With it set, Electron starts as plain Node and `import { app } from 'electron'` fails.
delete process.env.ELECTRON_RUN_AS_NODE;

const sdk = JSON.parse(readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8')) as { version: string };

export default defineConfig({
  main: {
    define: { __CLAUDE_SDK_VERSION__: JSON.stringify(sdk.version) },
    build: {
      // The SDK spawns a platform binary that it finds next to itself in node_modules, so it cannot be bundled.
      externalizeDeps: { include: ['@anthropic-ai/claude-agent-sdk'] },
    },
  },
  preload: {
    // A sandboxed preload cannot load ES modules, even though the package is type: module.
    build: { rolldownOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'office-csp',
        apply: 'build',
        transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
      },
    ],
  },
});
