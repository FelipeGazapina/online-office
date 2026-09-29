import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Only the built page gets a CSP: the dev server's HMR needs inline scripts and a websocket.
// Style is 'unsafe-inline' because mermaid's SVG and drei's labels carry inline styles.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

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
      {
        name: 'office-csp',
        apply: 'build',
        transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
      },
    ],
  },
});
