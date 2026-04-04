import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const libsqlSqlite3Entry = require.resolve('@libsql/client/sqlite3');
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');

export default defineConfig({
  resolve: {
    alias: {
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
