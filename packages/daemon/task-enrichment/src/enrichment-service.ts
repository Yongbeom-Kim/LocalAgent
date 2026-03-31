import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, ExecutorPreference, createLogger } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  system_prompt?: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
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

    const systemPrompt = rule.system_prompt?.trim() || undefined;

    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executors,
      submitted_at: task.submitted_at,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      marketplaces: rule.marketplaces,
      ...(task.task_source ? { task_source: task.task_source } : {}),
      ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
      ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
    };
  }
}
