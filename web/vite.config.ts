import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env['PORT'] ?? '4380';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
