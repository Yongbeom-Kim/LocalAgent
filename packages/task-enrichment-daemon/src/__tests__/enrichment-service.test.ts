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
          code_review: { executor: 'claude_code', executor_model: 'opus' },
          quick_question: { executor: 'claude_code', executor_model: 'haiku' },
          default: { executor: 'claude_code', executor_model: 'sonnet' },
        },
      });
    });

    it('enriches a task with a matching rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('task-123');
      expect(result!.task_type).toBe('code_review');
      expect(result!.payload).toBe('Review this code');
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('opus');
      expect(result!.submitted_at).toBe('2026-03-29T00:00:00.000Z');
    });

    it('falls back to default for unknown task_type', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));

      expect(result).not.toBeNull();
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('sonnet');
    });

    it('returns all required JobSubmission fields', () => {
      const result = service.enrich(createTask());

      expect(result).toHaveProperty('task_id');
      expect(result).toHaveProperty('task_type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('executor');
      expect(result).toHaveProperty('executor_model');
      expect(result).toHaveProperty('submitted_at');
    });
  });

  describe('with no default rule', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: { executor: 'claude_code', executor_model: 'opus' },
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
      expect(result!.executor).toBe('claude_code');
    });
  });

  describe('validation', () => {
    it('returns null for invalid executor', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_rule: { executor: 'nonexistent', executor_model: 'opus' },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_rule' }));
      expect(result).toBeNull();
    });

    it('returns null for invalid executor_model', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_model: { executor: 'claude_code', executor_model: 'nonexistent' },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_model' }));
      expect(result).toBeNull();
    });
  });

  describe('fromFile', () => {
    it('loads config from a YAML file', () => {
      const configPath = new URL('../../config/enrichment.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('sonnet');
    });
  });
});
