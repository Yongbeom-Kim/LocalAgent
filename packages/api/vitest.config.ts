import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const expressEntry = require.resolve('express');
const supertestEntry = require.resolve('supertest');
const amqplibEntry = require.resolve('amqplib');
const uuidEntry = require.resolve('uuid');
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');
const sharedSource = resolve(__dirname, '../shared/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@local-agent/shared': sharedSource,
      express: expressEntry,
      supertest: supertestEntry,
      amqplib: amqplibEntry,
      uuid: uuidEntry,
      dotenv: dotenvEntry,
      pino: pinoEntry,
      uuidv7: uuidv7Entry,
    },
  },
  test: {
    root: './src',
  },
});
