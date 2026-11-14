import { existsSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Use the same .env as the server so the dev proxy targets the right port.
const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const apiPort = process.env['PORT'] ?? '4380';

/** Light theme colour (matches `--bg` in web/src/styles.css). */
const THEME_COLOUR = '#faf7f1';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Bookshelf',
        short_name: 'Bookshelf',
        description: 'A personal reading tracker: sessions, progress, goals and stats.',
        lang: 'en-GB',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: THEME_COLOUR,
        theme_color: THEME_COLOUR,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only: built assets, the barcode wasm and icons. API
        // responses are never precached; the client keeps its own read model
        // in IndexedDB (ADR 0007).
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,wasm}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Cover images: served from our origin, cached for offline use.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith('/api/covers/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'bookshelf-covers',
              expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
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
