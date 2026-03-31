# Design: Multi-YAML Enrichment Config

**Date:** 2026-03-31
**Status:** Draft

## Problem

The enrichment daemon loads its rule configuration from a single YAML file (`config/enrichment.yaml`). As the number of task types and enrichment rules grows, a single file becomes unwieldy and makes it harder to separate concerns across teams or feature areas.

## Goal

Allow the `config/` directory to contain multiple YAML files, each with the same `rules:` schema. At daemon startup, all YAML files in the directory are loaded and their rule maps are merged into a single set. This lets operators organize rules by concern (e.g., `lark-rules.yaml`, `claude-rules.yaml`) without changing the schema or merging logic at runtime.

## Constraints & Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Motivation | Separation of concerns | One YAML per team/feature area |
| Config path mechanism | New `ENRICHMENT_CONFIG_DIR` env var | Clean break from single-file `ENRICHMENT_CONFIG_PATH` |
| Default path | `../config/` directory | Current `enrichment.yaml` still works since it's in that directory |
| Conflict handling | Error on duplicate rule keys | Prevents silent override bugs; forces explicit rule ownership |
| File ordering | No ordering guarantee | Irrelevant since conflicts are errors, not merges |
| Empty directory | Fail to start | No config = misconfiguration |
| Invalid YAML file | Fail to start | All files must be valid |
| Non-YAML files | Silently ignored | Only `*.yaml` and `*.yml` are loaded |
| API surface | `EnrichmentService.fromDirectory()` | Natural extension of existing `fromFile()` |

## Design

### Config Changes (`config.ts`)

The `EnrichmentDaemonConfig` interface changes:

```typescript
interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  enrichmentConfigDir: string;  // was enrichmentConfigPath
  larkAppId?: string;
  larkAppSecret?: string;
}
```

- New env var: `ENRICHMENT_CONFIG_DIR`
- Default: `resolve(__dirname, '../config')`
- Old `ENRICHMENT_CONFIG_PATH` / `enrichmentConfigPath` are removed

### Directory Loading (`enrichment-service.ts`)

New static method on `EnrichmentService`:

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

Key behaviors:
- Reads all `*.yaml` / `*.yml` files from the directory
- Parses each file, validates it has a `rules` object
- Merges all rules into a single map
- Throws on duplicate rule keys across files
- Throws if no YAML files exist in the directory

### Entry Point Changes (`index.ts`)

```typescript
// Before:
const enrichmentService = EnrichmentService.fromFile(config.enrichmentConfigPath);

// After:
const enrichmentService = EnrichmentService.fromDirectory(config.enrichmentConfigDir);
```

### Existing `fromFile()` / `fromObject()`

Both remain unchanged. `fromFile()` is still useful for tests that want to load a single file. `fromObject()` is used by unit tests that construct configs programmatically.

## Example: Multiple Config Files

```
config/
├── default.yaml       # Default rule for unmatched task types
├── lark-rules.yaml    # Rules specific to Lark-sourced tasks
└── ttadk-rules.yaml   # Rules for TTADK executor tasks
```

`default.yaml`:
```yaml
rules:
  default:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

`lark-rules.yaml`:
```yaml
rules:
  lark_conversation:
    executors:
      - executor: claude_code
        executor_model: opus
    marketplaces:
      - url: https://marketplace.example.com
        plugins: ["lark-context"]
```

`ttadk-rules.yaml`:
```yaml
rules:
  code_review:
    executors:
      - executor: ttadk
        executor_model: glm-5-ttadk
```

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/task-enrichment/src/config.ts` | Rename field to `enrichmentConfigDir`, new env var `ENRICHMENT_CONFIG_DIR`, default to `../config` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Add `fromDirectory()` static method |
| `packages/daemon/task-enrichment/src/index.ts` | Call `fromDirectory()` instead of `fromFile()` |
| `packages/daemon/task-enrichment/src/__tests__/config.test.ts` | Update tests for new env var and field name |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Add tests for `fromDirectory()`: happy path, duplicate key error, empty directory, invalid file |

## Out of Scope

- Schema validation (Zod or JSON Schema) — the existing runtime validation in `enrich()` is sufficient
- Hot-reloading config files at runtime — config is loaded once at startup
- Ordering guarantees between files — not needed since duplicate keys error
