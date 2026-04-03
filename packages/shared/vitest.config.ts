import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');

export default defineConfig({
  resolve: {
    alias: {
      dotenv: dotenvEntry,
      pino: pinoEntry,
      uuidv7: uuidv7Entry,
    },
  },
  test: {
    root: './src',
  },
});
