import { describe, it, expect } from 'vitest';
import {
  EXECUTOR_MODELS,
  isValidExecutorModel,
  getExecutorModelOptions,
  TASK_PHASES,
  isValidTaskPhase,
  compareTaskPhases,
  type Job,
  type MarketplaceConfig,
  isValidExecutorPreferences,
  isTaskExecutorType,
  type TaskResultSubmission,
  isControlTaskType,
  type Task,
  type TaskSubmission,
  LARK_INBOUND_SCHEMA_VERSION_V1,
  TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
  isValidLarkInboundEnvelope,
  isValidTelegramInboundEnvelope,
  isValidTaskEvent,
  isValidTelegramTopicTaskSource,
  type LarkInboundEnvelope,
  type TelegramInboundEnvelope,
} from '../types';
import { TASK_EVENT_KINDS } from '../constants';

/** Exact static allowlist order for `cursor` (must match `EXECUTOR_MODELS.cursor`). */
const CURSOR_AGENT_MODELS_EXPECTED = [
  'auto',
  'composer-2-fast',
  'composer-2',
  'composer-1.5',
  'gpt-5.3-codex-low',
  'gpt-5.3-codex-low-fast',
  'gpt-5.3-codex',
  'gpt-5.3-codex-fast',
  'gpt-5.3-codex-high',
  'gpt-5.3-codex-high-fast',
  'gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-xhigh-fast',
  'gpt-5.2',
  'gpt-5.3-codex-spark-preview-low',
  'gpt-5.3-codex-spark-preview',
  'gpt-5.3-codex-spark-preview-high',
  'gpt-5.3-codex-spark-preview-xhigh',
  'gpt-5.2-codex-low',
  'gpt-5.2-codex-low-fast',
  'gpt-5.2-codex',
  'gpt-5.2-codex-fast',
  'gpt-5.2-codex-high',
  'gpt-5.2-codex-high-fast',
  'gpt-5.2-codex-xhigh',
  'gpt-5.2-codex-xhigh-fast',
  'gpt-5.1-codex-max-low',
  'gpt-5.1-codex-max-low-fast',
  'gpt-5.1-codex-max-medium',
  'gpt-5.1-codex-max-medium-fast',
  'gpt-5.1-codex-max-high',
  'gpt-5.1-codex-max-high-fast',
  'gpt-5.1-codex-max-xhigh',
  'gpt-5.1-codex-max-xhigh-fast',
  'gpt-5.4-high',
  'gpt-5.4-high-fast',
  'gpt-5.4-xhigh-fast',
  'claude-4.6-opus-high-thinking',
  'gpt-5.4-low',
  'gpt-5.4-medium',
  'gpt-5.4-medium-fast',
  'gpt-5.4-xhigh',
  'claude-4.6-sonnet-medium',
  'claude-4.6-sonnet-medium-thinking',
  'claude-4.6-opus-high',
  'claude-4.6-opus-max',
  'claude-4.6-opus-max-thinking',
  'claude-4.5-opus-high',
  'claude-4.5-opus-high-thinking',
  'gpt-5.2-low',
  'gpt-5.2-low-fast',
  'gpt-5.2-fast',
  'gpt-5.2-high',
  'gpt-5.2-high-fast',
  'gpt-5.2-xhigh',
  'gpt-5.2-xhigh-fast',
  'gemini-3.1-pro',
  'gpt-5.4-mini-none',
  'gpt-5.4-mini-low',
  'gpt-5.4-mini-medium',
  'gpt-5.4-mini-high',
  'gpt-5.4-mini-xhigh',
  'gpt-5.4-nano-none',
  'gpt-5.4-nano-low',
  'gpt-5.4-nano-medium',
  'gpt-5.4-nano-high',
  'gpt-5.4-nano-xhigh',
  'grok-4-20',
  'grok-4-20-thinking',
  'claude-4.5-sonnet',
  'claude-4.5-sonnet-thinking',
  'gpt-5.1-low',
  'gpt-5.1',
  'gpt-5.1-high',
  'gemini-3-flash',
  'gpt-5.1-codex-mini-low',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-mini-high',
  'claude-4-sonnet',
  'claude-4-sonnet-1m',
  'claude-4-sonnet-thinking',
  'claude-4-sonnet-1m-thinking',
  'gpt-5-mini',
  'kimi-k2.5',
] as const;

describe('EXECUTOR_MODELS', () => {
  it('defines claude models', () => {
    expect(EXECUTOR_MODELS.claude).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('defines claude-w models', () => {
    expect(EXECUTOR_MODELS['claude-w']).toEqual([
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.2',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'minimax-2.5',
      'minimax-2.7',
    ]);
  });

  it('defines builtin models', () => {
    expect(EXECUTOR_MODELS.builtin).toEqual(['none']);
  });

  it('defines cursor static allowlist', () => {
    expect(EXECUTOR_MODELS.cursor).toEqual(CURSOR_AGENT_MODELS_EXPECTED);
  });

  it('defines ttcodex models', () => {
    expect(EXECUTOR_MODELS.ttcodex).toEqual(['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex']);
  });
});

describe('isTaskExecutorType', () => {
  it('accepts canonical executor names', () => {
    expect(isTaskExecutorType('claude')).toBe(true);
    expect(isTaskExecutorType('claude-w')).toBe(true);
    expect(isTaskExecutorType('builtin')).toBe(true);
    expect(isTaskExecutorType('cursor')).toBe(true);
    expect(isTaskExecutorType('ttcodex')).toBe(true);
  });

  it('rejects legacy executor names', () => {
    expect(isTaskExecutorType('claude_code')).toBe(false);
    expect(isTaskExecutorType('cursor_agent')).toBe(false);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isTaskExecutorType('ttadk')).toBe(false);
    expect(isTaskExecutorType('')).toBe(false);
    expect(isTaskExecutorType(null)).toBe(false);
    expect(isTaskExecutorType(undefined)).toBe(false);
  });
});

describe('isValidExecutorModel', () => {
  it('returns true for valid claude model', () => {
    expect(isValidExecutorModel('claude', 'opus')).toBe(true);
    expect(isValidExecutorModel('claude', 'sonnet')).toBe(true);
    expect(isValidExecutorModel('claude', 'haiku')).toBe(true);
  });

  it('returns true for valid claude-w model', () => {
    expect(isValidExecutorModel('claude-w', 'gpt-5.4')).toBe(true);
    expect(isValidExecutorModel('claude-w', 'glm-5')).toBe(true);
  });

  it('returns true for valid builtin model', () => {
    expect(isValidExecutorModel('builtin', 'none')).toBe(true);
  });

  it('returns false for invalid builtin model', () => {
    expect(isValidExecutorModel('builtin', 'opus')).toBe(false);
  });

  it('returns false for cross-executor mismatch', () => {
    expect(isValidExecutorModel('claude', 'gpt-5.4')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'opus')).toBe(false);
  });

  it('returns false for removed ttadk executor and model names', () => {
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(false);
    expect(isValidExecutorModel('claude-w', 'glm-5-ttadk')).toBe(false);
  });

  it('returns true for valid ttcodex models and false for invalid ones', () => {
    expect(isValidExecutorModel('ttcodex', 'gpt-5.4')).toBe(true);
    expect(isValidExecutorModel('ttcodex', 'gpt-5.3-codex')).toBe(true);
    expect(isValidExecutorModel('ttcodex', 'gpt-5.2-codex')).toBe(true);
    expect(isValidExecutorModel('ttcodex', 'gpt-5.1')).toBe(false);
  });

  it('returns false for unknown model strings', () => {
    expect(isValidExecutorModel('claude', 'gpt-4o')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'unknown')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isValidExecutorModel('claude', 123)).toBe(false);
    expect(isValidExecutorModel('claude', undefined)).toBe(false);
    expect(isValidExecutorModel('claude', null)).toBe(false);
  });

  it('validates cursor models against the static allowlist', () => {
    expect(isValidExecutorModel('cursor', 'auto')).toBe(true);
    expect(isValidExecutorModel('cursor', 'gpt-5.4-medium-fast')).toBe(true);
    expect(isValidExecutorModel('cursor', 'claude-4.6-sonnet-medium-thinking')).toBe(true);
    expect(isValidExecutorModel('cursor', 'not-a-real-model')).toBe(false);
    expect(isValidExecutorModel('cursor', 'bad id with spaces')).toBe(false);
    expect(isValidExecutorModel('cursor', 'gpt-5.4-medium-ultra')).toBe(false);
  });
});

describe('getExecutorModelOptions', () => {
  it('returns comma-separated list for claude', () => {
    expect(getExecutorModelOptions('claude')).toBe('opus, sonnet, haiku');
  });

  it('returns comma-separated list for claude-w', () => {
    expect(getExecutorModelOptions('claude-w')).toBe(
      'gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, glm-5, glm-4.7, kimi-k2.5, minimax-2.5, minimax-2.7',
    );
  });

  it('returns comma-separated list for builtin', () => {
    expect(getExecutorModelOptions('builtin')).toBe('none');
  });

  it('returns comma-separated list for cursor', () => {
    expect(getExecutorModelOptions('cursor')).toBe(EXECUTOR_MODELS.cursor.join(', '));
  });

  it('returns comma-separated list for ttcodex', () => {
    expect(getExecutorModelOptions('ttcodex')).toBe('gpt-5.4, gpt-5.3-codex, gpt-5.2-codex');
  });
});

describe('MarketplaceConfig', () => {
  it('accepts marketplaces field on Job', () => {
    const marketplaces: MarketplaceConfig[] = [
      { url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] },
    ];
    const job: Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
      session_id: 's1',
      marketplaces: [{ url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] }],
    };
    expect(job.marketplaces).toHaveLength(1);
    expect(job.marketplaces![0].url).toBe('https://github.com/example/repo.git');
    expect(job.marketplaces![0].plugins).toEqual(['my-plugin']);
    expect(marketplaces).toHaveLength(1);
  });

  it('allows Job without marketplaces field', () => {
    const job: Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
      session_id: 's1',
    };
    expect(job.marketplaces).toBeUndefined();
  });
});

describe('isValidExecutorPreferences', () => {
  it('returns true for valid non-empty array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'sonnet' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns true for single-element array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'opus' },
    ])).toBe(true);
  });

  it('returns true for builtin executor with none model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'builtin', executor_model: 'none' },
    ])).toBe(true);
  });

  it('returns true for cursor with allowlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor', executor_model: 'auto' },
    ])).toBe(true);
  });

  it('returns true for ttcodex with allowlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'ttcodex', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns false for cursor with unlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor', executor_model: 'not-a-real-model' },
    ])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isValidExecutorPreferences([])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isValidExecutorPreferences('claude')).toBe(false);
    expect(isValidExecutorPreferences(null)).toBe(false);
    expect(isValidExecutorPreferences(undefined)).toBe(false);
  });

  it('returns false when any pair has invalid executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'sonnet' },
      { executor: 'nonexistent', executor_model: 'opus' },
    ])).toBe(false);
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false when any pair has invalid model for its executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false for array with non-object elements', () => {
    expect(isValidExecutorPreferences(['claude'])).toBe(false);
  });
});

describe('TaskResultSubmission executor metadata', () => {
  it('accepts optional executor metadata on TaskResultSubmission shape', () => {
    const result: TaskResultSubmission = {
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      session_id: 'session-1',
      status: 'success',
      exit_code: 0,
      stdout: 'done',
      stderr: '',
      executor: 'claude',
      executor_model: 'sonnet',
    };

    expect(result.executor).toBe('claude');
    expect(result.executor_model).toBe('sonnet');
  });
});

describe('isControlTaskType', () => {
  it('returns true for control task types', () => {
    expect(isControlTaskType('new_instance')).toBe(true);
    expect(isControlTaskType('gc')).toBe(true);
    expect(isControlTaskType('cleanup')).toBe(true);
  });

  it('returns false for normal task types', () => {
    expect(isControlTaskType('code_review')).toBe(false);
    expect(isControlTaskType('generic')).toBe(false);
  });
});

describe('TaskSubmission routing fields', () => {
  it('allows explicit routing fields on TaskSubmission', () => {
    const task: TaskSubmission = {
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
      executor_model: 'sonnet',
      session_id: 'session-123',
      context_ref: {
        platform: 'lark',
        root_key: 'om_root_123',
      },
    };
    expect(task.executor_model).toBe('sonnet');
    expect(task.session_id).toBe('session-123');
    expect(task.context_ref).toEqual({
      platform: 'lark',
      root_key: 'om_root_123',
    });

    const schedulerTask: TaskSubmission = {
      task_type: 'code_review',
      payload: 'daily summary',
      session_id: 'session-scheduler-1',
      session: {
        fallbackSeedText: 'daily summary',
        fallbackOrigin: 'scheduler',
        fallbackTitleHint: 'Daily summary',
      },
    };

    expect(schedulerTask.session).toEqual({
      fallbackSeedText: 'daily summary',
      fallbackOrigin: 'scheduler',
      fallbackTitleHint: 'Daily summary',
    });
  });

  it('allows control-task submissions without executor fields', () => {
    const task: TaskSubmission = {
      task_type: 'cleanup',
      payload: '',
      session_id: 'session-cleanup-1',
    };
    expect(task.executor).toBeUndefined();
  });

  it('requires canonical routing fields on TaskSubmission', () => {
    const task: TaskSubmission = {
      task_type: 'generic',
      payload: 'hello',
      session_id: 'session-hello-1',
    };

    expect(task.session_id).toBe('session-hello-1');
    expect(task.context_ref).toBeUndefined();
  });

  it('preserves canonical routing fields on Task', () => {
    const task: Task = {
      task_id: 'task-123',
      task_type: 'generic',
      payload: 'hello',
      submitted_at: '2026-04-07T00:00:00.000Z',
      session_id: 'session-123',
      context_ref: {
        platform: 'telegram',
        root_key: '-100123:42',
      },
    };

    expect(task.session_id).toBe('session-123');
    expect(task.context_ref).toEqual({
      platform: 'telegram',
      root_key: '-100123:42',
    });
  });
});

describe('session_id-only outbound routing contracts', () => {
  it('accepts result events only when session_id is present', () => {
    expect(isValidTaskEvent({
      event_kind: 'result',
      result_id: 'result-1',
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      session_id: 'session-1',
      status: 'success',
      exit_code: 0,
      stdout: 'done',
      stderr: '',
      completed_at: '2026-04-09T00:00:00.000Z',
    })).toBe(true);

    expect(isValidTaskEvent({
      event_kind: 'result',
      result_id: 'result-1',
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      status: 'success',
      exit_code: 0,
      stdout: 'done',
      stderr: '',
      completed_at: '2026-04-09T00:00:00.000Z',
    })).toBe(false);
  });

  it('accepts phase events only when session_id is present', () => {
    expect(isValidTaskEvent({
      event_kind: 'phase',
      event_id: 'event-1',
      task_id: 'task-1',
      session_id: 'session-1',
      task_type: 'generic',
      phase: 'queued',
      emitted_at: '2026-04-09T00:00:00.000Z',
    })).toBe(true);

    expect(isValidTaskEvent({
      event_kind: 'phase',
      event_id: 'event-1',
      task_id: 'task-1',
      task_type: 'generic',
      phase: 'queued',
      emitted_at: '2026-04-09T00:00:00.000Z',
    })).toBe(false);
  });
});

describe('task phase events', () => {
  it('exports the supported task phases in lifecycle order', () => {
    expect(TASK_PHASES).toEqual(['received', 'enriching', 'queued', 'executing', 'completed']);
  });

  it('validates task phase payload values', () => {
    expect(isValidTaskPhase('queued')).toBe(true);
    expect(isValidTaskPhase('completed')).toBe(true);
    expect(isValidTaskPhase('unknown')).toBe(false);
    expect(isValidTaskPhase(123)).toBe(false);
  });

  it('compares task phases monotonically', () => {
    expect(compareTaskPhases('queued', 'executing')).toBeLessThan(0);
    expect(compareTaskPhases('executing', 'queued')).toBeGreaterThan(0);
    expect(compareTaskPhases('completed', 'completed')).toBe(0);
  });
});

describe('telegram task source contracts', () => {
  it('accepts a telegram task source with chat and topic ids', () => {
    expect(isValidTelegramTopicTaskSource({
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    })).toBe(true);
  });

  it('rejects a telegram topic task source missing topic_id', () => {
    expect(isValidTelegramTopicTaskSource({
      source: 'telegram',
      chat_id: '-100123',
      message_id: '99',
    })).toBe(false);
  });
});

describe('supported task event kinds', () => {
  it('does not expose mirror in TASK_EVENT_KINDS', () => {
    expect(TASK_EVENT_KINDS).toEqual(['result', 'phase']);
    expect(isValidTaskEvent({ event_kind: 'mirror' })).toBe(false);
  });
});

describe('LarkInboundEnvelope (normalized lark_inbound contract)', () => {
  it('accepts a minimally valid root-message envelope (root_message_id = message_id; thread_id = null)', () => {
    const env: LarkInboundEnvelope = {
      platform: 'lark',
      schema_version: LARK_INBOUND_SCHEMA_VERSION_V1,
      message_id: 'om_root',
      root_message_id: 'om_root',
      thread_id: null,
      chat_type: 'p2p',
      sender_open_id: 'ou_123',
      sender_type: 'user',
      message_type: 'text',
      raw_content: JSON.stringify({ text: 'hello' }),
      normalized_text: 'hello',
      mentions: [],
      is_normalizable: true,
      occurred_at_ms: 1743811200000,
    };

    expect(isValidLarkInboundEnvelope(env)).toBe(true);
    // Serialization-safe primitives (no functions, Dates, or non-JSON values).
    const roundTrip = JSON.parse(JSON.stringify(env)) as unknown;
    expect(isValidLarkInboundEnvelope(roundTrip)).toBe(true);
  });

  it('requires normalized_text when is_normalizable = true', () => {
    const env = {
      platform: 'lark',
      schema_version: 1,
      message_id: 'om_1',
      root_message_id: 'om_1',
      chat_type: 'p2p',
      sender_open_id: 'ou_123',
      sender_type: 'user',
      message_type: 'text',
      raw_content: JSON.stringify({ text: 'hello' }),
      mentions: [],
      is_normalizable: true,
      occurred_at_ms: 1,
    };

    expect(isValidLarkInboundEnvelope(env)).toBe(false);
  });

  it('allows non-normalizable envelopes to omit normalized_text', () => {
    const env = {
      platform: 'lark',
      schema_version: 1,
      message_id: 'om_child',
      root_message_id: 'om_root',
      thread_id: 'omt_1',
      chat_type: 'group',
      sender_open_id: 'ou_999',
      sender_type: 'user',
      message_type: 'sticker',
      raw_content: JSON.stringify({ sticker_id: 'abc' }),
      mentions: [],
      is_normalizable: false,
      occurred_at_ms: 2,
    };

    expect(isValidLarkInboundEnvelope(env)).toBe(true);
    expect(JSON.stringify(env)).toContain('"raw_content"');
  });
});

describe('TelegramInboundEnvelope (normalized telegram_inbound contract)', () => {
  it('accepts a minimally valid topic message envelope', () => {
    const env: TelegramInboundEnvelope = {
      platform: 'telegram',
      schema_version: TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
      sender_id: '12345',
      sender_is_bot: false,
      message_type: 'text',
      raw_content: 'hello',
      normalized_text: 'hello',
      is_normalizable: true,
      occurred_at_ms: 1743811200000,
    };

    expect(isValidTelegramInboundEnvelope(env)).toBe(true);
    const roundTrip = JSON.parse(JSON.stringify(env)) as unknown;
    expect(isValidTelegramInboundEnvelope(roundTrip)).toBe(true);
  });

  it('requires normalized_text when is_normalizable = true', () => {
    expect(isValidTelegramInboundEnvelope({
      platform: 'telegram',
      schema_version: 1,
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
      sender_id: '12345',
      sender_is_bot: false,
      message_type: 'text',
      raw_content: 'hello',
      is_normalizable: true,
      occurred_at_ms: 1,
    })).toBe(false);
  });
});
