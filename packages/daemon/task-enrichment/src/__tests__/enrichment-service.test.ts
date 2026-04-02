import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Task, JobSubmission, GLOBAL_SYSTEM_PROMPT } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

const TEST_SESSION_ID = 'session-123';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this code',
    submitted_at: '2026-03-29T00:00:00.000Z',
    executor: 'claude',
    executor_model: 'sonnet',
    ...overrides,
  };
}

describe('EnrichmentService', () => {
  describe('with rules including default', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: {
            system_prompt: 'Code review focus.',
          },
          quick_question: {},
          default: {},
        },
      });
    });

    it('enriches a task with a matching rule', () => {
      const result = service.enrich(
        createTask({ task_type: 'code_review', executor: 'claude', executor_model: 'opus' }),
        TEST_SESSION_ID,
      );

      expect(result.type).toBe('enriched');
      const enriched = result as { type: 'enriched'; job: JobSubmission };
      expect(enriched.job.task_id).toBe('task-123');
      expect(enriched.job.task_type).toBe('code_review');
      expect(enriched.job.payload).toBe('Review this code');
      expect(enriched.job.executors).toEqual([{ executor: 'claude', executor_model: 'opus' }]);
      expect(enriched.job.submitted_at).toBe('2026-03-29T00:00:00.000Z');
    });

    it('returns rejected result for unknown task_type (no default fallback)', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }), TEST_SESSION_ID);

      expect(result.type).toBe('rejected');
    });

    it('returns all required JobSubmission fields', () => {
      const result = service.enrich(createTask(), TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      const enriched = result as { type: 'enriched'; job: JobSubmission };
      expect(enriched.job).toHaveProperty('task_id');
      expect(enriched.job).toHaveProperty('task_type');
      expect(enriched.job).toHaveProperty('session_id', TEST_SESSION_ID);
      expect(enriched.job).toHaveProperty('payload');
      expect(enriched.job).toHaveProperty('executors');
      expect(enriched.job).toHaveProperty('submitted_at');
    });

    it('builds job.executors from explicit task routing only', () => {
      const result = service.enrich(
        createTask({ task_type: 'code_review', executor: 'claude', executor_model: 'opus' }),
        TEST_SESSION_ID,
      );

      expect(result.type).toBe('enriched');
      const enriched = result as { type: 'enriched'; job: JobSubmission };
      expect(enriched.job.executors).toEqual([{ executor: 'claude', executor_model: 'opus' }]);
      expect(enriched.job.executors).toHaveLength(1);
    });
  });

  describe('with no default rule', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: {},
        },
      });
    });

    it('returns rejected result for unknown task_type when no default exists', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }), TEST_SESSION_ID);
      expect(result.type).toBe('rejected');
    });

    it('still enriches known task_types', () => {
      const result = service.enrich(createTask(), TEST_SESSION_ID);
      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('returns rejected result when task has invalid executor routing', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_rule: {},
        },
      });

      const result = service.enrich(
        createTask({ task_type: 'bad_rule', executor: 'claude', executor_model: 'not-a-valid-model' }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('rejected');
    });

    it('returns rejected when non-control task omits executor', () => {
      const service = EnrichmentService.fromObject({ rules: { code_review: {} } });
      const result = service.enrich(
        createTask({ executor: undefined, executor_model: undefined }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('rejected');
    });

    it('enriches when cursor uses allowlisted model gpt-5.4-medium-fast', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          cursor_task: {},
        },
      });

      const result = service.enrich(
        createTask({ task_type: 'cursor_task', executor: 'cursor', executor_model: 'gpt-5.4-medium-fast' }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
        { executor: 'cursor', executor_model: 'gpt-5.4-medium-fast' },
      ]);
    });

    it('returns rejected result when cursor uses unlisted model', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_cursor: {},
        },
      });

      const result = service.enrich(
        createTask({ task_type: 'bad_cursor', executor: 'cursor', executor_model: 'not-a-real-model' }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('rejected');
    });
  });

  describe('explicit routing contract', () => {
    it('builds job.executors from explicit task routing', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          code_review: {
            system_prompt: 'Review carefully.',
          },
        },
      });

      const result = service.enrich(
        createTask({
          task_type: 'code_review',
          executor: 'claude',
          executor_model: 'sonnet',
        }),
        TEST_SESSION_ID,
      );

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
        { executor: 'claude', executor_model: 'sonnet' },
      ]);
    });

    it('rejects unknown task_type even when executor/model are valid', () => {
      const service = EnrichmentService.fromObject({ rules: {} });
      const result = service.enrich(
        createTask({
          task_type: 'missing',
          executor: 'claude',
          executor_model: 'sonnet',
        }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('rejected');
    });

    it('includes setup_hook metadata without requiring executors in YAML', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          coding: {
            setup_hook: 'npm ci',
            setup_hook_timeout_ms: 120_000,
          },
        },
      });
      const result = service.enrich(createTask({ task_type: 'coding' }), TEST_SESSION_ID);
      expect(result.type).toBe('enriched');
      const job = (result as { type: 'enriched'; job: JobSubmission }).job;
      expect(job.setup_hook).toBe('npm ci');
      expect(job.setup_hook_timeout_ms).toBe(120_000);
    });

    it('sets builtin executor for cleanup when task omits executor/model', () => {
      const service = EnrichmentService.fromObject({
        rules: { cleanup: {} },
      });
      const result = service.enrich(
        createTask({ task_type: 'cleanup', payload: '', executor: undefined, executor_model: undefined }),
        TEST_SESSION_ID,
      );
      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
        { executor: 'builtin', executor_model: 'none' },
      ]);
    });

    it('rejects gc at enrichment layer', () => {
      const service = EnrichmentService.fromObject({ rules: { gc: {} } });
      const result = service.enrich(createTask({ task_type: 'gc', payload: '' }), TEST_SESSION_ID);
      expect(result.type).toBe('rejected');
    });
  });

  describe('fromFile', () => {
    it('loads config from a YAML file', () => {
      const configPath = new URL('../../config/enrichment.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(createTask({ task_type: 'generic' }), TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
    });

    it('loads cleanup rule from builtin config with builtin executor', () => {
      const configPath = new URL('../../config/builtin.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(
        createTask({ task_type: 'cleanup', payload: '', executor: undefined, executor_model: undefined }),
        TEST_SESSION_ID,
      );

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
        { executor: 'builtin', executor_model: 'none' },
      ]);
    });
  });

  describe('marketplace passthrough', () => {
    it('includes marketplaces from rule in enriched job', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          development: {
            marketplaces: [
              { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['superpowers'] },
              { url: 'https://github.com/Yongbeom-Kim/personal-claude-code.git', plugins: ['development'] },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'development' }), TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      const enriched = result as { type: 'enriched'; job: JobSubmission };
      expect(enriched.job.marketplaces).toHaveLength(2);
      expect(enriched.job.marketplaces![0].url).toBe('https://github.com/anthropics/claude-plugins-official.git');
      expect(enriched.job.marketplaces![0].plugins).toEqual(['superpowers']);
    });

    it('omits marketplaces when rule has none', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          default: {},
        },
      });

      const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.marketplaces).toBeUndefined();
    });
  });

  describe('history passthrough', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          default: {},
        },
      });
    });

    it('includes history in enriched job when provided', () => {
      const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID, 'Earlier thread context');

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.history).toBe('Earlier thread context');
    });

    it('omits history when not provided', () => {
      const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.history).toBeUndefined();
    });

    it('omits history when undefined is passed explicitly', () => {
      const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID, undefined);

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.history).toBeUndefined();
    });
  });

  describe('task_source passthrough', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          default: {},
        },
      });
    });

    it('includes task_source in enriched job when present on task', () => {
      const task = createTask({ task_type: 'default', task_source: { source: 'lark', message_id: 'om_abc' } });
      const result = service.enrich(task, TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.task_source).toEqual({ source: 'lark', message_id: 'om_abc' });
    });

    it('omits task_source when not present on task', () => {
      const task = createTask({ task_type: 'default' });
      const result = service.enrich(task, TEST_SESSION_ID);

      expect(result.type).toBe('enriched');
      expect((result as { type: 'enriched'; job: JobSubmission }).job.task_source).toBeUndefined();
    });
  });
});

describe('rejection for unknown types (no default fallback)', () => {
  let service: EnrichmentService;

  beforeEach(() => {
    service = EnrichmentService.fromObject({
      rules: {
        generic: {},
        code_review: {},
      },
    });
  });

  it('returns rejected result for unknown task_type', () => {
    const result = service.enrich(createTask({ task_type: 'nonexistent' }), TEST_SESSION_ID);

    expect(result).toEqual({
      type: 'rejected',
      reason: expect.stringContaining('Unknown task type "nonexistent"'),
    });
  });

  it('includes valid types in rejection reason', () => {
    const result = service.enrich(createTask({ task_type: 'nonexistent' }), TEST_SESSION_ID);

    expect(result).toHaveProperty('type', 'rejected');
    expect((result as { type: 'rejected'; reason: string }).reason).toContain('generic');
    expect((result as { type: 'rejected'; reason: string }).reason).toContain('code_review');
  });

  it('returns enriched result for known task_type', () => {
    const result = service.enrich(createTask({ task_type: 'generic' }), TEST_SESSION_ID);

    expect(result).toHaveProperty('type', 'enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
      { executor: 'claude', executor_model: 'sonnet' },
    ]);
  });
});

describe('getValidTypes', () => {
  it('returns all rule keys', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        generic: {},
        code_review: {},
      },
    });

    expect(service.getValidTypes()).toEqual(expect.arrayContaining(['generic', 'code_review']));
    expect(service.getValidTypes()).toHaveLength(2);
  });
});

describe('fromDirectory', () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'enrichment-config-'));
  }

  it('loads and merges rules from multiple YAML files including builtin.yaml', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'builtin.yaml'), `rules:\n  cleanup: {}\n`);
    writeFileSync(join(dir, 'enrichment.yaml'), `rules:\n  default: {}\n`);
    writeFileSync(join(dir, 'local.yaml'), `rules:\n  code_review: {}\n`);

    const service = EnrichmentService.fromDirectory(dir);

    const cleanupResult = service.enrich(
      createTask({ task_type: 'cleanup', payload: '', executor: undefined, executor_model: undefined }),
      TEST_SESSION_ID,
    );
    expect(cleanupResult.type).toBe('enriched');
    expect((cleanupResult as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([{ executor: 'builtin', executor_model: 'none' }]);

    const defaultResult = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);
    expect(defaultResult.type).toBe('enriched');
    expect((defaultResult as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([{ executor: 'claude', executor_model: 'sonnet' }]);

    const reviewResult = service.enrich(createTask({ task_type: 'code_review' }), TEST_SESSION_ID);
    expect(reviewResult.type).toBe('enriched');
    expect((reviewResult as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([{ executor: 'claude', executor_model: 'sonnet' }]);
  });

  it('loads .yml files as well as .yaml', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'rules.yml'), `rules:\n  default: {}\n`);

    const service = EnrichmentService.fromDirectory(dir);
    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);
    expect(result.type).toBe('enriched');
  });

  it('ignores non-YAML files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'readme.md'), '# Not a config');
    writeFileSync(join(dir, 'rules.yaml'), `rules:\n  default: {}\n`);

    const service = EnrichmentService.fromDirectory(dir);
    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);
    expect(result.type).toBe('enriched');
  });

  it('throws on duplicate rule keys across files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.yaml'), `rules:\n  default: {}\n`);
    writeFileSync(join(dir, 'b.yaml'), `rules:\n  default: {}\n`);

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

describe('setup_hook passthrough', () => {
  it('includes setup_hook and setup_hook_timeout_ms in enriched job when present in rule', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        coding: {
          setup_hook: 'git clone https://github.com/org/repo .\nnpm ci',
          setup_hook_timeout_ms: 120_000,
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'coding' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.setup_hook).toBe('git clone https://github.com/org/repo .\nnpm ci');
    expect(enriched.job.setup_hook_timeout_ms).toBe(120_000);
  });

  it('omits setup_hook when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {},
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.setup_hook).toBeUndefined();
    expect(enriched.job.setup_hook_timeout_ms).toBeUndefined();
  });

  it('includes setup_hook without timeout when only hook is specified', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          setup_hook: 'echo hello',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.setup_hook).toBe('echo hello');
    expect(enriched.job.setup_hook_timeout_ms).toBeUndefined();
  });
});

describe('getValidTaskTypes', () => {
  it('returns set of all rule keys', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        code_review: {},
        deploy: {},
        default: {},
      },
    });

    const types = service.getValidTaskTypes();

    expect(types).toEqual(new Set(['code_review', 'deploy', 'default']));
  });

  it('returns empty set when no rules', () => {
    const service = EnrichmentService.fromObject({ rules: {} });
    const types = service.getValidTaskTypes();
    expect(types).toEqual(new Set());
  });
});

describe('system_prompt passthrough', () => {
  it('prepends global system prompt to rule system_prompt', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        code_review: {
          system_prompt: 'You are a code reviewer. Focus on security.',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'code_review' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.system_prompt).toBe(
      `${GLOBAL_SYSTEM_PROMPT}\n\nYou are a code reviewer. Focus on security.`,
    );
  });

  it('uses only global system prompt when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {},
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.system_prompt).toBe(GLOBAL_SYSTEM_PROMPT);
  });

  it('uses only global system prompt when rule system_prompt is empty', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          system_prompt: '',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.system_prompt).toBe(GLOBAL_SYSTEM_PROMPT);
  });

  it('uses only global system prompt when rule system_prompt is whitespace', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          system_prompt: '   \n  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.system_prompt).toBe(GLOBAL_SYSTEM_PROMPT);
  });

  it('trims leading/trailing whitespace from rule system_prompt before combining', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          system_prompt: '  Be concise.  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.system_prompt).toBe(
      `${GLOBAL_SYSTEM_PROMPT}\n\nBe concise.`,
    );
  });
});
