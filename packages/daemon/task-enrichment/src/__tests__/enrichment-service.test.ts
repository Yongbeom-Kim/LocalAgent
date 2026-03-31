import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Task } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this code',
    submitted_at: '2026-03-29T00:00:00.000Z',
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
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'claude_code', executor_model: 'sonnet' },
            ],
          },
          quick_question: {
            executors: [
              { executor: 'claude_code', executor_model: 'haiku' },
            ],
          },
          default: {
            executors: [
              { executor: 'claude_code', executor_model: 'sonnet' },
              { executor: 'ttadk', executor_model: 'gpt-5.4' },
            ],
          },
        },
      });
    });

    it('enriches a task with a matching rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('task-123');
      expect(result!.task_type).toBe('code_review');
      expect(result!.payload).toBe('Review this code');
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'claude_code', executor_model: 'sonnet' },
      ]);
      expect(result!.submitted_at).toBe('2026-03-29T00:00:00.000Z');
    });

    it('falls back to default for unknown task_type', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));

      expect(result).not.toBeNull();
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'sonnet' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ]);
    });

    it('returns all required JobSubmission fields', () => {
      const result = service.enrich(createTask());

      expect(result).toHaveProperty('task_id');
      expect(result).toHaveProperty('task_type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('executors');
      expect(result).toHaveProperty('submitted_at');
    });

    it('preserves executor preference order from rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result!.executors[0]).toEqual({ executor: 'claude_code', executor_model: 'opus' });
      expect(result!.executors[1]).toEqual({ executor: 'claude_code', executor_model: 'sonnet' });
    });
  });

  describe('with no default rule', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: {
            executors: [{ executor: 'claude_code', executor_model: 'opus' }],
          },
        },
      });
    });

    it('returns null for unknown task_type when no default exists', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));
      expect(result).toBeNull();
    });

    it('still enriches known task_types', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));
      expect(result).not.toBeNull();
      expect(result!.executors).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('returns null when any executor in array is invalid', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_rule: {
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'nonexistent', executor_model: 'opus' },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_rule' }));
      expect(result).toBeNull();
    });

    it('returns null when any executor_model in array is invalid', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_model: {
            executors: [
              { executor: 'claude_code', executor_model: 'nonexistent' },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_model' }));
      expect(result).toBeNull();
    });

    it('returns null when executors array is empty', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          empty: { executors: [] },
        },
      });

      const result = service.enrich(createTask({ task_type: 'empty' }));
      expect(result).toBeNull();
    });
  });

  describe('fromFile', () => {
    it('loads config from a YAML file', () => {
      const configPath = new URL('../../config/enrichment.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'sonnet' },
      ]);
    });
  });

  describe('marketplace passthrough', () => {
    it('includes marketplaces from rule in enriched job', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          development: {
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'claude_code', executor_model: 'sonnet' },
            ],
            marketplaces: [
              { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['superpowers'] },
              { url: 'https://github.com/Yongbeom-Kim/personal-claude-code.git', plugins: ['development'] },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'development' }));

      expect(result).not.toBeNull();
      expect(result!.marketplaces).toHaveLength(2);
      expect(result!.marketplaces![0].url).toBe('https://github.com/anthropics/claude-plugins-official.git');
      expect(result!.marketplaces![0].plugins).toEqual(['superpowers']);
    });

    it('omits marketplaces when rule has none', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          default: {
            executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.marketplaces).toBeUndefined();
    });
  });

  describe('task_source passthrough', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          default: {
            executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          },
        },
      });
    });

    it('includes task_source in enriched job when present on task', () => {
      const task = createTask({ task_source: { source: 'lark', message_id: 'om_abc' } });
      const result = service.enrich(task);

      expect(result).not.toBeNull();
      expect(result!.task_source).toEqual({ source: 'lark', message_id: 'om_abc' });
    });

    it('omits task_source when not present on task', () => {
      const task = createTask();
      const result = service.enrich(task);

      expect(result).not.toBeNull();
      expect(result!.task_source).toBeUndefined();
    });
  });
});

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

describe('setup_hook passthrough', () => {
  it('includes setup_hook and setup_hook_timeout_ms in enriched job when present in rule', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        coding: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          setup_hook: 'git clone https://github.com/org/repo .\nnpm ci',
          setup_hook_timeout_ms: 120_000,
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'coding' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBe('git clone https://github.com/org/repo .\nnpm ci');
    expect(result!.setup_hook_timeout_ms).toBe(120_000);
  });

  it('omits setup_hook when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBeUndefined();
    expect(result!.setup_hook_timeout_ms).toBeUndefined();
  });

  it('includes setup_hook without timeout when only hook is specified', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          setup_hook: 'echo hello',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBe('echo hello');
    expect(result!.setup_hook_timeout_ms).toBeUndefined();
  });
});

describe('system_prompt passthrough', () => {
  it('includes system_prompt in enriched job when rule has one', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        code_review: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: 'You are a code reviewer. Focus on security.',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'code_review' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBe('You are a code reviewer. Focus on security.');
  });

  it('omits system_prompt when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('treats empty string system_prompt as absent', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('treats whitespace-only system_prompt as absent', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '   \n  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('trims leading/trailing whitespace from system_prompt', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '  Be concise.  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBe('Be concise.');
  });
});
