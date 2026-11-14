import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['web/src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'web/src/**/*.{ts,tsx}'],
      // Entry points run in their own process (server/index.test.ts boots it) or
      // only mount the app, so in-process coverage cannot see them.
      exclude: [
        '**/*.test.{ts,tsx}',
        'server/test/**',
        'server/index.ts',
        'web/src/test/**',
        'web/src/main.tsx',
      ],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: {
        'server/**/*.ts': { lines: 90 },
        'shared/**/*.ts': { lines: 90 },
      },
    },
  },
});
