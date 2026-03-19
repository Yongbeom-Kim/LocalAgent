export const EXCHANGES = {
  tasks: "tasks.exchange",
  jobs: "jobs.exchange",
  results: "results.exchange",
} as const;

export const QUEUES = {
  tasks: "tasks.queue",
  jobs: "jobs.queue",
  results: "results.queue",
} as const;

export const QUEUE_MAP = {
  tasks: {
    queue: QUEUES.tasks,
    exchange: EXCHANGES.tasks,
    routingKeyPrefix: "task",
  },
  jobs: {
    queue: QUEUES.jobs,
    exchange: EXCHANGES.jobs,
    routingKeyPrefix: "job",
  },
  results: {
    queue: QUEUES.results,
    exchange: EXCHANGES.results,
    routingKeyPrefix: "result",
  },
} as const;

export type QueueName = keyof typeof QUEUE_MAP;

export function routingKey(prefix: string, suffix: string): string {
  return `${prefix}.${suffix}`;
}

export const DEFAULTS = {
  TASK_TIMEOUT_MS: 3_600_000,
  POLL_INTERVAL_MS: 5_000,
  IN_FLIGHT_TTL_MS: 4_200_000,
  SCAVENGER_INTERVAL_MS: 60_000,
} as const;
