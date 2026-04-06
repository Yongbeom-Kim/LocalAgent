import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const commanderEntry = require.resolve('commander');
const libsqlSqlite3Entry = require.resolve('@libsql/client/sqlite3');
const drizzleOrmEntry = require.resolve('drizzle-orm');
const drizzleLibsqlSqlite3Entry = require.resolve('drizzle-orm/libsql/sqlite3');
const drizzleLibsqlEntry = require.resolve('drizzle-orm/libsql');
const drizzleSqliteCoreEntry = require.resolve('drizzle-orm/sqlite-core');
const drizzleOrmSqlEntry = require.resolve('drizzle-orm/sql');
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');
const sharedSource = resolve(__dirname, '../shared/src/index.ts');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@local-agent/shared', replacement: sharedSource },
      { find: '@libsql/client/sqlite3', replacement: libsqlSqlite3Entry },
      { find: /^drizzle-orm\/libsql\/sqlite3$/, replacement: drizzleLibsqlSqlite3Entry },
      { find: /^drizzle-orm\/libsql$/, replacement: drizzleLibsqlEntry },
      { find: /^drizzle-orm\/sqlite-core$/, replacement: drizzleSqliteCoreEntry },
      { find: /^drizzle-orm\/sql$/, replacement: drizzleOrmSqlEntry },
      { find: /^drizzle-orm$/, replacement: drizzleOrmEntry },
      { find: /^commander$/, replacement: commanderEntry },
      { find: /^dotenv$/, replacement: dotenvEntry },
      { find: /^pino$/, replacement: pinoEntry },
      { find: /^uuidv7$/, replacement: uuidv7Entry },
    ],
  },
  test: {
    root: './src',
  },
});
