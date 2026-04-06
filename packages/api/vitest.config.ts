import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const libsqlSqlite3Entry = require.resolve('@libsql/client/sqlite3');
const drizzleOrmEntry = require.resolve('drizzle-orm');
const drizzleLibsqlSqlite3Entry = require.resolve('drizzle-orm/libsql/sqlite3');
const drizzleLibsqlEntry = require.resolve('drizzle-orm/libsql');
const drizzleSqliteCoreEntry = require.resolve('drizzle-orm/sqlite-core');
const drizzleOrmSqlEntry = require.resolve('drizzle-orm/sql');
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
      '@libsql/client/sqlite3': libsqlSqlite3Entry,
      'drizzle-orm/libsql/sqlite3': drizzleLibsqlSqlite3Entry,
      'drizzle-orm/libsql': drizzleLibsqlEntry,
      'drizzle-orm/sqlite-core': drizzleSqliteCoreEntry,
      'drizzle-orm/sql': drizzleOrmSqlEntry,
      'drizzle-orm': drizzleOrmEntry,
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
