import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  Task,
  JobSubmission,
  isTaskExecutorType,
  isValidExecutorModel,
  ExecutorPreference,
  createLogger,
  GLOBAL_SYSTEM_PROMPT,
  isControlTaskType,
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
  formatMissingTaskTypeMessage,
  formatUnknownTaskTypeMessage,
  formatMissingExecutorMessage,
  formatMissingModelMessage,
  formatMissingPayloadMessage,
} from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

function getRoutingRejection(
  command: '/task' | '/new',
  executor: unknown,
  executorModel: unknown,
): string | null {
  if (!isTaskExecutorType(executor)) {
    return formatInvalidExecutorMessage(command, String(executor));
  }
  if (!isValidExecutorModel(executor, executorModel)) {
    return formatInvalidModelMessage(command, executor, String(executorModel));
  }
  return null;
}

interface EnrichmentRule {
  system_prompt?: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

interface EnrichmentConfig {
  rules: Record<string, EnrichmentRule>;
}

export type EnrichmentResult =
  | { type: 'enriched'; job: JobSubmission }
  | { type: 'rejected'; reason: string };

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

  enrich(task: Task, sessionId: string, history?: string): EnrichmentResult {
    const normalizedTaskType = task.task_type.trim();

    if (!normalizedTaskType) {
      return {
        type: 'rejected',
        reason: formatMissingTaskTypeMessage(this.getValidTypes()),
      };
    }

    const rule = this.rules[normalizedTaskType];
    if (!rule) {
      return {
        type: 'rejected',
        reason: formatUnknownTaskTypeMessage(normalizedTaskType, this.getValidTypes()),
      };
    }

    if (normalizedTaskType === 'gc') {
      logger.error({ task_id: task.task_id }, 'gc task reached enrichment — invalid configuration');
      return {
        type: 'rejected',
        reason: 'Task type "gc" must be handled by the enrichment poller, not enrichment rules.',
      };
    }

    let executors: ExecutorPreference[];

    if (!isControlTaskType(normalizedTaskType)) {
      if (!task.executor || task.executor.trim() === '') {
        return {
          type: 'rejected',
          reason: formatMissingExecutorMessage(normalizedTaskType),
        };
      }
      if (!isTaskExecutorType(task.executor)) {
        return { type: 'rejected', reason: formatInvalidExecutorMessage('/task', task.executor) };
      }
      const exec = task.executor;
      if (!task.executor_model || task.executor_model.trim() === '') {
        return {
          type: 'rejected',
          reason: formatMissingModelMessage(exec),
        };
      }
      if (!isValidExecutorModel(exec, task.executor_model)) {
        return {
          type: 'rejected',
          reason: formatInvalidModelMessage('/task', exec, task.executor_model),
        };
      }
      if (task.payload.trim() === '') {
        return { type: 'rejected', reason: formatMissingPayloadMessage() };
      }
      executors = [{ executor: exec, executor_model: task.executor_model }];
    } else if (normalizedTaskType === 'cleanup' || normalizedTaskType === 'kill') {
      executors = [{ executor: 'builtin', executor_model: 'none' }];
    } else if (normalizedTaskType === 'new_instance') {
      if (task.executor && task.executor_model) {
        const routingRejection = getRoutingRejection('/new', task.executor, task.executor_model);
        if (routingRejection) {
          return { type: 'rejected', reason: routingRejection };
        }
        if (!isTaskExecutorType(task.executor)) {
          return { type: 'rejected', reason: formatInvalidExecutorMessage('/new', task.executor) };
        }
        executors = [{ executor: task.executor, executor_model: task.executor_model }];
      } else {
        executors = [{ executor: 'claude', executor_model: 'sonnet' }];
      }
    } else {
      return { type: 'rejected', reason: `Unsupported control task type "${normalizedTaskType}".` };
    }

    const rulePrompt = rule.system_prompt?.trim() || '';
    const systemPrompt = rulePrompt
      ? `${GLOBAL_SYSTEM_PROMPT}\n\n${rulePrompt}`
      : GLOBAL_SYSTEM_PROMPT;

    return {
      type: 'enriched',
      job: {
        task_id: task.task_id,
        task_type: normalizedTaskType,
        session_id: sessionId,
        payload: task.payload,
        ...(history ? { history } : {}),
        executors,
        submitted_at: task.submitted_at,
        system_prompt: systemPrompt,
        marketplaces: rule.marketplaces,
        ...(task.task_source ? { task_source: task.task_source } : {}),
        ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
        ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
      },
    };
  }

  getValidTypes(): string[] {
    return Object.keys(this.rules);
  }

  getValidTaskTypes(): Set<string> {
    return new Set(Object.keys(this.rules));
  }
}
