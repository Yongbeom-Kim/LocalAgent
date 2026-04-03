import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const sharedDist = resolve(__dirname, '../../shared/dist/index.js');

export default defineConfig({
  resolve: {
    alias: {
      '@local-agent/shared': sharedDist,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
