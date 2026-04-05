import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';

function createRepositoryMocks() {
  return {
    getLarkMessageByMessageId: vi.fn(),
    getLarkThreadByRootMessageId: vi.fn(),
    getLarkMessagesForThread: vi.fn(),
  };
}

describe('ThreadContextFetcher', () => {
  const validTypes = new Set(['deploy', 'code_review']);
  let repository: ReturnType<typeof createRepositoryMocks>;
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    repository = createRepositoryMocks();
    fetcher = new ThreadContextFetcher(repository);
  });

  it('returns not_thread for a root message', async () => {
    repository.getLarkMessageByMessageId.mockResolvedValue({
      messageId: 'om_root_1',
      source: 'lark',
      rootMessageId: 'om_root_1',
      sessionId: 'session_1',
      threadId: null,
      direction: 'inbound',
      senderType: 'user',
      messageType: 'text',
      rawContent: '{"text":"hello"}',
      normalizedText: 'hello',
      metadataJson: null,
      createdAtMs: 100,
    });

    await expect(fetcher.fetchThreadContext('om_root_1', validTypes)).resolves.toEqual({
      kind: 'not_thread',
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });
  });

  it('returns error when the source message is missing', async () => {
    repository.getLarkMessageByMessageId.mockResolvedValue(null);

    const result = await fetcher.fetchThreadContext('om_missing', validTypes);

    expect(result.kind).toBe('error');
    expect(result.reason).toContain('om_missing');
  });

  it('builds thread history from persisted messages and excludes the current message', async () => {
    repository.getLarkMessageByMessageId.mockResolvedValue({
      messageId: 'om_reply_1',
      source: 'lark',
      rootMessageId: 'om_root_1',
      sessionId: 'session_1',
      threadId: 'omt_1',
      direction: 'inbound',
      senderType: 'user',
      messageType: 'text',
      rawContent: '{"text":"follow up"}',
      normalizedText: 'follow up',
      metadataJson: null,
      createdAtMs: 300,
    });
    repository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_1',
      threadId: 'omt_1',
      sessionId: 'session_1',
      source: 'lark',
      chatType: 'p2p',
      taskType: 'deploy',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 100,
      updatedAtMs: 300,
      endedAtMs: null,
    });
    repository.getLarkMessagesForThread.mockResolvedValue([
      {
        messageId: 'om_root_1',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"fix the CI pipeline"}',
        normalizedText: 'fix the CI pipeline',
        metadataJson: null,
        createdAtMs: 100,
      },
      {
        messageId: 'om_bot_1',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: 'omt_1',
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: '{"text":"done"}',
        normalizedText: 'task_type: deploy\nsession_id: session_1\nexecutor: claude\nmodel: sonnet\nDone',
        metadataJson: '{"event_kind":"reply"}',
        createdAtMs: 200,
      },
      {
        messageId: 'om_reply_1',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: 'omt_1',
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"follow up"}',
        normalizedText: 'follow up',
        metadataJson: null,
        createdAtMs: 300,
      },
    ]);

    await expect(fetcher.fetchThreadContext('om_reply_1', validTypes)).resolves.toEqual({
      kind: 'thread',
      threadContext: 'user: fix the CI pipeline\nassistant: Done',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'session_1',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });
  });

  it('applies the last /new fence before building history', async () => {
    repository.getLarkMessageByMessageId.mockResolvedValue({
      messageId: 'om_reply_after_new',
      source: 'lark',
      rootMessageId: 'om_root_2',
      sessionId: 'session_2',
      threadId: 'omt_2',
      direction: 'inbound',
      senderType: 'user',
      messageType: 'text',
      rawContent: '{"text":"what next"}',
      normalizedText: 'what next',
      metadataJson: null,
      createdAtMs: 500,
    });
    repository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_2',
      threadId: 'omt_2',
      sessionId: 'session_2',
      source: 'lark',
      chatType: 'p2p',
      taskType: 'deploy',
      executor: 'cursor',
      executorModel: 'auto',
      status: 'active',
      createdAtMs: 100,
      updatedAtMs: 500,
      endedAtMs: null,
    });
    repository.getLarkMessagesForThread.mockResolvedValue([
      {
        messageId: 'om_root_2',
        source: 'lark',
        rootMessageId: 'om_root_2',
        sessionId: 'session_2',
        threadId: null,
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"old context"}',
        normalizedText: 'old context',
        metadataJson: null,
        createdAtMs: 100,
      },
      {
        messageId: 'om_new_reply',
        source: 'lark',
        rootMessageId: 'om_root_2',
        sessionId: 'session_2',
        threadId: 'omt_2',
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: '{"text":"New session instance started."}',
        normalizedText: 'task_type: deploy\nsession_id: session_2\nexecutor: cursor\nmodel: auto\nNew session instance started.',
        metadataJson: '{"event_kind":"new_instance_reply"}',
        createdAtMs: 400,
      },
      {
        messageId: 'om_reply_after_new',
        source: 'lark',
        rootMessageId: 'om_root_2',
        sessionId: 'session_2',
        threadId: 'omt_2',
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"what next"}',
        normalizedText: 'what next',
        metadataJson: null,
        createdAtMs: 500,
      },
    ]);

    const result = await fetcher.fetchThreadContext('om_reply_after_new', validTypes);

    expect(result).toEqual({
      kind: 'thread',
      threadContext: 'assistant: New session instance started.',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'session_2',
      inheritedExecutor: 'cursor',
      inheritedExecutorModel: 'auto',
    });
  });

  it('returns error for thread replies when the root thread is still audit-only', async () => {
    repository.getLarkMessageByMessageId.mockResolvedValue({
      messageId: 'om_reply_pending',
      source: 'lark',
      rootMessageId: 'om_root_pending',
      sessionId: 'om_root_pending',
      threadId: 'omt_pending',
      direction: 'inbound',
      senderType: 'user',
      messageType: 'text',
      rawContent: '{"text":"follow up"}',
      normalizedText: 'follow up',
      metadataJson: null,
      createdAtMs: 200,
    });
    repository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_pending',
      threadId: 'omt_pending',
      sessionId: 'om_root_pending',
      source: 'lark',
      chatType: 'p2p',
      taskType: 'unknown',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'audit_only',
      createdAtMs: 100,
      updatedAtMs: 200,
      endedAtMs: null,
    });

    const result = await fetcher.fetchThreadContext('om_reply_pending', validTypes);

    expect(result).toEqual({
      kind: 'error',
      reason: 'This thread has not been classified yet. Please retry after the root message is processed.',
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });
    expect(repository.getLarkMessagesForThread).not.toHaveBeenCalled();
  });
});
