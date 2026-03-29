import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, createLogger } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

interface EnrichmentRule {
  executor: string;
  executor_model: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}

interface EnrichmentConfig {
  rules: Record<string, EnrichmentRule>;
}

export class EnrichmentService {
  private constructor(private readonly rules: Record<string, EnrichmentRule>) {}

  static fromFile(filePath: string): EnrichmentService {
    const content = readFileSync(filePath, 'utf-8');
    const config = yaml.load(content) as EnrichmentConfig;
    return new EnrichmentService(config.rules);
  }

  static fromObject(config: EnrichmentConfig): EnrichmentService {
    return new EnrichmentService(config.rules);
  }

  enrich(task: Task): JobSubmission | null {
    const rule = this.rules[task.task_type] ?? this.rules['default'];

    if (!rule) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'No enrichment rule found and no default — rejecting task');
      return null;
    }

    if (!isTaskExecutorType(rule.executor)) {
      logger.error({ task_id: task.task_id, executor: rule.executor }, 'Invalid executor in enrichment rule — rejecting task');
      return null;
    }

    if (!isValidExecutorModel(rule.executor as TaskExecutorType, rule.executor_model)) {
      logger.error({ task_id: task.task_id, executor: rule.executor, model: rule.executor_model }, 'Invalid executor_model in enrichment rule — rejecting task');
      return null;
    }

    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executor: rule.executor as TaskExecutorType,
      executor_model: rule.executor_model,
      submitted_at: task.submitted_at,
      marketplaces: rule.marketplaces,
    };
  }
}
