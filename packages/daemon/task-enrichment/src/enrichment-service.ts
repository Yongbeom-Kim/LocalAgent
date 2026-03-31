import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, ExecutorPreference, createLogger } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
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

    if (!rule.executors || rule.executors.length === 0) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'Enrichment rule has empty executors array — rejecting task');
      return null;
    }

    const executors: ExecutorPreference[] = [];
    for (const entry of rule.executors) {
      if (!isTaskExecutorType(entry.executor)) {
        logger.error({ task_id: task.task_id, executor: entry.executor }, 'Invalid executor in enrichment rule — rejecting task');
        return null;
      }
      if (!isValidExecutorModel(entry.executor as TaskExecutorType, entry.executor_model)) {
        logger.error({ task_id: task.task_id, executor: entry.executor, model: entry.executor_model }, 'Invalid executor_model in enrichment rule — rejecting task');
        return null;
      }
      executors.push({ executor: entry.executor as TaskExecutorType, executor_model: entry.executor_model });
    }

    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executors,
      submitted_at: task.submitted_at,
      marketplaces: rule.marketplaces,
      ...(task.task_source ? { task_source: task.task_source } : {}),
    };
  }
}
