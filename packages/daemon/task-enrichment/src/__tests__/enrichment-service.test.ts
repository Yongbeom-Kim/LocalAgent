import { describe, it, expect, beforeEach } from 'vitest';
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
