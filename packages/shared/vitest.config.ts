import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const libsqlSqlite3Entry = require.resolve('@libsql/client/sqlite3');
const drizzleOrmEntry = require.resolve('drizzle-orm');
// Drizzle uses deep ESM/CJS exports; Vitest+Vite module resolution can be flaky in Rush monorepos.
// Alias these to their resolved entries to make tests stable.
const drizzleLibsqlSqlite3Entry = require.resolve('drizzle-orm/libsql/sqlite3');
const drizzleLibsqlEntry = require.resolve('drizzle-orm/libsql');
const drizzleSqliteCoreEntry = require.resolve('drizzle-orm/sqlite-core');
const drizzleOrmSqlEntry = require.resolve('drizzle-orm/sql');
const dotenvEntry = require.resolve('dotenv');
const pinoEntry = require.resolve('pino');
const uuidv7Entry = require.resolve('uuidv7');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@libsql/client/sqlite3', replacement: libsqlSqlite3Entry },
      { find: /^drizzle-orm\/libsql\/sqlite3$/, replacement: drizzleLibsqlSqlite3Entry },
      { find: /^drizzle-orm\/libsql$/, replacement: drizzleLibsqlEntry },
      { find: /^drizzle-orm\/sqlite-core$/, replacement: drizzleSqliteCoreEntry },
      { find: /^drizzle-orm\/sql$/, replacement: drizzleOrmSqlEntry },
      { find: /^drizzle-orm$/, replacement: drizzleOrmEntry },
      { find: /^dotenv$/, replacement: dotenvEntry },
      { find: /^pino$/, replacement: pinoEntry },
      { find: /^uuidv7$/, replacement: uuidv7Entry },
    ],
  },
  test: {
    root: './src',
  },
});
