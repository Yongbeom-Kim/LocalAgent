# Multi-YAML Enrichment Config Implementation Plan

**Goal:** Allow the enrichment daemon to load and merge multiple YAML config files from a directory instead of a single file.

**Architecture:** Add `EnrichmentService.fromDirectory()` that scans a directory for `*.yaml`/`*.yml` files, parses each, and merges their `rules` maps — erroring on duplicate keys. The daemon config switches from `ENRICHMENT_CONFIG_PATH` (single file) to `ENRICHMENT_CONFIG_DIR` (directory). Existing `fromFile()` and `fromObject()` remain for test use.

**Tech Stack:** TypeScript, Vitest, js-yaml, Node.js `fs` (readdirSync/readFileSync)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/daemon/task-enrichment/src/config.ts` | Modify | Rename field/env var, change default to directory |
| `packages/daemon/task-enrichment/src/__tests__/config.test.ts` | Modify | Update tests for new field name and env var |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Add `fromDirectory()` static method |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Add `fromDirectory()` tests |
| `packages/daemon/task-enrichment/src/index.ts` | Modify | Wire `fromDirectory()` |

---

### Task 1: Update daemon config to use `ENRICHMENT_CONFIG_DIR`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/__tests__/config.test.ts`
- Modify: `packages/daemon/task-enrichment/src/config.ts`

- [ ] **Step 1: Update config test for new field name and env var**

In `packages/daemon/task-enrichment/src/__tests__/config.test.ts`, update:

1. In the `'returns defaults when no env vars set'` test, replace the `enrichmentConfigPath` assertion:

```typescript
// Remove:
// (no explicit enrichmentConfigPath assertion exists, but verify the new field)
```

Add this assertion in the defaults test:

```typescript
expect(config.enrichmentConfigDir).toMatch(/config$/);
```

2. In the `'reads from env vars'` test, add `ENRICHMENT_CONFIG_DIR` to the env input and assert on it:

```typescript
const config = loadEnrichmentDaemonConfig({
  API_URL: 'http://other:4000',
  POLL_INTERVAL_MS: '2000',
  LOG_LEVEL: 'debug',
  LARK_APP_ID: 'app123',
  LARK_APP_SECRET: 'secret456',
  ENRICHMENT_CONFIG_DIR: '/custom/config/dir',
});
// ...existing assertions...
expect(config.enrichmentConfigDir).toBe('/custom/config/dir');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `enrichmentConfigDir` does not exist on the config object yet.

- [ ] **Step 3: Update `config.ts` to use `enrichmentConfigDir`**

In `packages/daemon/task-enrichment/src/config.ts`:

1. Change the default constant (line 20):

```typescript
// Before:
const DEFAULT_ENRICHMENT_CONFIG_PATH = resolve(__dirname, '../config/enrichment.yaml');

// After:
const DEFAULT_ENRICHMENT_CONFIG_DIR = resolve(__dirname, '../config');
```

2. Rename the interface field (line 15):

```typescript
// Before:
enrichmentConfigPath: string;

// After:
enrichmentConfigDir: string;
```

3. Update the loader function (line 27):

```typescript
// Before:
enrichmentConfigPath: env.ENRICHMENT_CONFIG_PATH ?? DEFAULT_ENRICHMENT_CONFIG_PATH,

// After:
enrichmentConfigDir: env.ENRICHMENT_CONFIG_DIR ?? DEFAULT_ENRICHMENT_CONFIG_DIR,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/config.ts packages/daemon/task-enrichment/src/__tests__/config.test.ts
git commit -m "refactor(enrichment): rename config to enrichmentConfigDir with ENRICHMENT_CONFIG_DIR env var"
```

---

### Task 2: Add `fromDirectory()` to `EnrichmentService`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`

- [ ] **Step 1: Write failing tests for `fromDirectory()`**

Add a new `describe('fromDirectory')` block at the end of `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`. These tests use `mkdtempSync`/`writeFileSync` to create temporary directories with YAML files:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
```

Add these at the top of the file alongside existing imports.

Then add the describe block:

```typescript
describe('fromDirectory', () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'enrichment-config-'));
  }

  it('loads and merges rules from multiple YAML files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.yaml'), `rules:\n  default:\n    executors:\n      - executor: claude_code\n        executor_model: sonnet\n`);
    writeFileSync(join(dir, 'b.yaml'), `rules:\n  code_review:\n    executors:\n      - executor: claude_code\n        executor_model: opus\n`);

    const service = EnrichmentService.fromDirectory(dir);

    const defaultResult = service.enrich(createTask({ task_type: 'unknown' }));
    expect(defaultResult).not.toBeNull();
    expect(defaultResult!.executors).toEqual([{ executor: 'claude_code', executor_model: 'sonnet' }]);

    const reviewResult = service.enrich(createTask({ task_type: 'code_review' }));
    expect(reviewResult).not.toBeNull();
    expect(reviewResult!.executors).toEqual([{ executor: 'claude_code', executor_model: 'opus' }]);
  });

  it('loads .yml files as well as .yaml', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'rules.yml'), `rules:\n  default:\n    executors:\n      - executor: claude_code\n        executor_model: sonnet\n`);

    const service = EnrichmentService.fromDirectory(dir);
    const result = service.enrich(createTask({ task_type: 'anything' }));
    expect(result).not.toBeNull();
  });

  it('ignores non-YAML files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'readme.md'), '# Not a config');
    writeFileSync(join(dir, 'rules.yaml'), `rules:\n  default:\n    executors:\n      - executor: claude_code\n        executor_model: sonnet\n`);

    const service = EnrichmentService.fromDirectory(dir);
    const result = service.enrich(createTask({ task_type: 'anything' }));
    expect(result).not.toBeNull();
  });

  it('throws on duplicate rule keys across files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.yaml'), `rules:\n  default:\n    executors:\n      - executor: claude_code\n        executor_model: sonnet\n`);
    writeFileSync(join(dir, 'b.yaml'), `rules:\n  default:\n    executors:\n      - executor: claude_code\n        executor_model: opus\n`);

    expect(() => EnrichmentService.fromDirectory(dir)).toThrow(/Duplicate rule key 'default'/);
  });

  it('throws when directory has no YAML files', () => {
    const dir = makeTempDir();

    expect(() => EnrichmentService.fromDirectory(dir)).toThrow(/No YAML files found/);
  });

  it('throws when a YAML file has no rules key', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'bad.yaml'), `something_else:\n  key: value\n`);

    expect(() => EnrichmentService.fromDirectory(dir)).toThrow(/missing or invalid 'rules'/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `fromDirectory` is not a function.

- [ ] **Step 3: Implement `fromDirectory()` in `enrichment-service.ts`**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`:

1. Add imports at line 1:

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
```

Replace the existing `import { readFileSync } from 'node:fs';` with the above.

2. Add the `fromDirectory` static method after `fromObject` (after line 27):

```typescript
static fromDirectory(dirPath: string): EnrichmentService {
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => join(dirPath, f));

  if (files.length === 0) {
    throw new Error(`No YAML files found in config directory: ${dirPath}`);
  }

  const mergedRules: Record<string, EnrichmentRule> = {};

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const config = yaml.load(content) as EnrichmentConfig;

    if (!config?.rules || typeof config.rules !== 'object') {
      throw new Error(`Invalid config file (missing or invalid 'rules'): ${file}`);
    }

    for (const [key, rule] of Object.entries(config.rules)) {
      if (mergedRules[key]) {
        throw new Error(
          `Duplicate rule key '${key}' found in ${file} — already defined in another config file`
        );
      }
      mergedRules[key] = rule;
    }
  }

  return new EnrichmentService(mergedRules);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS (all tests including the new `fromDirectory` describe block)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): add fromDirectory() for multi-YAML config loading"
```

---

### Task 3: Wire `fromDirectory()` in daemon entry point

**Files:**
- Modify: `packages/daemon/task-enrichment/src/index.ts`

- [ ] **Step 1: Update `index.ts` to use `fromDirectory()`**

In `packages/daemon/task-enrichment/src/index.ts`, change lines 13-14:

```typescript
// Before:
const enrichmentService = EnrichmentService.fromFile(config.enrichmentConfigPath);
logger.info({ configPath: config.enrichmentConfigPath }, 'Loaded enrichment config');

// After:
const enrichmentService = EnrichmentService.fromDirectory(config.enrichmentConfigDir);
logger.info({ configDir: config.enrichmentConfigDir }, 'Loaded enrichment config');
```

- [ ] **Step 2: Run all tests to verify nothing is broken**

Run: `cd packages/daemon/task-enrichment && npx vitest run`
Expected: PASS (all tests)

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/index.ts
git commit -m "feat(enrichment): wire fromDirectory() in daemon entry point"
```

---

### Task 4: Run full build and verify

- [ ] **Step 1: Run TypeScript build**

Run: `cd packages/daemon/task-enrichment && npm run build`
Expected: No type errors, clean build.

- [ ] **Step 2: Run all tests one final time**

Run: `cd packages/daemon/task-enrichment && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Final commit (if any fixes were needed)**

Only if build or tests revealed issues that required fixes.
