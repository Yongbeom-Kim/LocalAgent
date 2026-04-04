import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const libsqlSqlite3Entry = require.resolve('@libsql/client/sqlite3');
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');
const sharedSource = resolve(__dirname, '../shared/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@local-agent/shared': sharedSource,
      '@libsql/client/sqlite3': libsqlSqlite3Entry,
      dotenv: dotenvEntry,
      pino: pinoEntry,
      uuidv7: uuidv7Entry,
    },
  },
  test: {
    root: './src',
  },
});

