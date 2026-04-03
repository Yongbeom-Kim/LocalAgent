import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const sharedSource = resolve(__dirname, '../../shared/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@local-agent/shared': sharedSource,
    },
  },
  test: {
    root: './src',
  },
});
