import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'world',
  plugins: [react()],
  server: { port: 5173 },
});
