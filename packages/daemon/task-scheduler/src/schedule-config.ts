import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import yaml from 'js-yaml';

export interface SchedulerTaskSubmission {
  task_type: string;
  executor: string;
  executor_model: string;
  payload: string;
}

export interface SchedulerScheduleEntry {
  name: string;
  cron: string;
  task: SchedulerTaskSubmission;
}

export interface SchedulerScheduleConfig {
  schedules: SchedulerScheduleEntry[];
}

const FORBIDDEN_TASK_KEYS = new Set([
  'task_source',
  'context_ref',
  'thread_id',
  'thread_key',
  'topic_id',
  'chat_id',
  'message_id',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} ${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

function listYamlFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listYamlFilesRecursively(fullPath));
      continue;
    }

    if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function validateTask(taskValue: unknown, scheduleName: string): SchedulerTaskSubmission {
  if (!isRecord(taskValue)) {
    throw new Error(`schedule ${scheduleName} task must be an object`);
  }

  for (const forbiddenKey of FORBIDDEN_TASK_KEYS) {
    if (forbiddenKey in taskValue) {
      throw new Error(`schedule ${scheduleName} task ${forbiddenKey} is not allowed`);
    }
  }

  return {
    task_type: requireString(taskValue, 'task_type', `schedule ${scheduleName} task`),
    executor: requireString(taskValue, 'executor', `schedule ${scheduleName} task`),
    executor_model: requireString(taskValue, 'executor_model', `schedule ${scheduleName} task`),
    payload: requireString(taskValue, 'payload', `schedule ${scheduleName} task`),
  };
}

function validateCronExpression(cron: string, scheduleName: string): void {
  try {
    CronExpressionParser.parse(cron);
  } catch {
    throw new Error(`schedule ${scheduleName} has invalid cron expression`);
  }
}

export function loadMergedScheduleConfig(configDir: string): SchedulerScheduleConfig {
  const scheduleEntries = new Map<string, SchedulerScheduleEntry>();
  const yamlFiles = listYamlFilesRecursively(configDir);

  for (const filePath of yamlFiles) {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);

    if (parsed === undefined || parsed === null) {
      continue;
    }

    if (!isRecord(parsed)) {
      throw new Error(`file ${relative(configDir, filePath)} must contain an object`);
    }

    const schedulesValue = parsed.schedules;
    if (schedulesValue === undefined || schedulesValue === null) {
      continue;
    }

    if (!isRecord(schedulesValue)) {
      throw new Error(`file ${relative(configDir, filePath)} schedules must be an object`);
    }

    for (const [name, scheduleValue] of Object.entries(schedulesValue)) {
      if (!name.trim()) {
        throw new Error(`file ${relative(configDir, filePath)} has an empty schedule name`);
      }

      if (scheduleEntries.has(name)) {
        throw new Error(`duplicate schedule name: ${name}`);
      }

      if (!isRecord(scheduleValue)) {
        throw new Error(`schedule ${name} must be an object`);
      }

      const cron = requireString(scheduleValue, 'cron', `schedule ${name}`);
      validateCronExpression(cron, name);
      const task = validateTask(scheduleValue.task, name);

      scheduleEntries.set(name, { name, cron, task });
    }
  }

  return {
    schedules: Array.from(scheduleEntries.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
