import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedDir = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': sharedDir },
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
