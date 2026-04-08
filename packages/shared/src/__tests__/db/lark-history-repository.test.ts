import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';
import { LarkHistoryRepository } from '../../db/lark-history-repository';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('LarkHistoryRepository', () => {
  it('records inbound audit rows with an audit-only placeholder and deduplicates by message_id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await expect(
        repository.recordInboundAuditMessage({
          envelope: {
            platform: 'lark',
            schema_version: 1,
            message_id: 'om_audit_1',
            root_message_id: 'om_root_audit',
            thread_id: 'omt_audit',
            chat_type: 'group',
            sender_open_id: 'ou_audit',
            sender_type: 'user',
            message_type: 'text',
            raw_content: '{"text":"/task deploy claude sonnet ship it"}',
            normalized_text: '/task deploy claude sonnet ship it',
            mentions: [{ key: '@bot', name: 'Bot', open_id: 'ou_bot' }],
            is_normalizable: true,
            occurred_at_ms: 100,
          },
        }),
      ).resolves.toBe(true);

      await expect(
        repository.recordInboundAuditMessage({
          envelope: {
            platform: 'lark',
            schema_version: 1,
            message_id: 'om_audit_1',
            root_message_id: 'om_root_audit',
            thread_id: 'omt_audit',
            chat_type: 'group',
            sender_open_id: 'ou_audit',
            sender_type: 'user',
            message_type: 'text',
            raw_content: '{"text":"/task deploy claude sonnet ship it"}',
            normalized_text: '/task deploy claude sonnet ship it',
            mentions: [],
            is_normalizable: true,
            occurred_at_ms: 100,
          },
        }),
      ).resolves.toBe(false);

      const thread = await repository.getLarkThreadByRootMessageId('om_root_audit');
      expect(thread).toEqual(
        expect.objectContaining({
          rootMessageId: 'om_root_audit',
          threadId: 'omt_audit',
          sessionId: 'om_root_audit',
          taskType: 'unknown',
          executor: 'claude',
          executorModel: 'sonnet',
          status: 'audit_only',
        }),
      );

      const rows = await repository.getLarkMessagesForThread('om_root_audit');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          messageId: 'om_audit_1',
          sessionId: 'om_root_audit',
          rootMessageId: 'om_root_audit',
          threadId: 'omt_audit',
          normalizedText: '/task deploy claude sonnet ship it',
        }),
      );

      expect(JSON.parse(rows[0].metadataJson ?? '{}')).toEqual({
        platform: 'lark',
        schema_version: 1,
        sender_open_id: 'ou_audit',
        mentions: [{ key: '@bot', name: 'Bot', open_id: 'ou_bot' }],
      });
    } finally {
      client.close();
    }
  });

  it('promotes audit-only placeholder state to authoritative thread state without losing inbound history', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.recordInboundAuditMessage({
        envelope: {
          platform: 'lark',
          schema_version: 1,
          message_id: 'om_root_promote',
          root_message_id: 'om_root_promote',
          thread_id: null,
          chat_type: 'p2p',
          sender_open_id: 'ou_promote',
          sender_type: 'user',
          message_type: 'text',
          raw_content: '{"text":"/task code_review claude sonnet review this"}',
          normalized_text: '/task code_review claude sonnet review this',
          mentions: [],
          is_normalizable: true,
          occurred_at_ms: 1000,
        },
      });

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_promote',
        threadId: 'omt_promote',
        sessionId: 'session_promote',
        source: 'lark',
        chatType: 'p2p',
        taskType: 'code_review',
        executor: 'cursor',
        executorModel: 'auto',
        status: 'active',
        createdAtMs: 1000,
        updatedAtMs: 1200,
        endedAtMs: null,
      });

      const thread = await repository.getLarkThreadByRootMessageId('om_root_promote');
      expect(thread).toEqual(
        expect.objectContaining({
          rootMessageId: 'om_root_promote',
          threadId: 'omt_promote',
          sessionId: 'session_promote',
          taskType: 'code_review',
          executor: 'cursor',
          executorModel: 'auto',
          status: 'active',
          updatedAtMs: 1200,
        }),
      );

      const rows = await repository.getLarkMessagesForThread('om_root_promote');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          messageId: 'om_root_promote',
          sessionId: 'session_promote',
          threadId: 'omt_promote',
        }),
      );
    } finally {
      client.close();
    }
  });

  it('upserts a lark thread row and inserts inbound message rows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_1',
        threadId: null,
        sessionId: 'session_1',
        source: 'lark',
        chatType: 'group',
        taskType: 'code_review',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 100,
        threadUpdatedAtMs: 100,
        message: {
          messageId: 'om_1',
          messageType: 'text',
          rawContent: '{"text":"please review this"}',
          normalizedText: 'please review this',
          metadataJson: '{"sender_open_id":"ou_x"}',
          createdAtMs: 100,
        },
      });

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_1',
        threadId: 'omt_thread_1',
        sessionId: 'session_1',
        source: 'lark',
        chatType: 'group',
        taskType: 'code_review',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 200,
        threadUpdatedAtMs: 250,
        message: {
          messageId: 'om_2',
          messageType: 'text',
          rawContent: '{"text":"follow-up"}',
          normalizedText: 'follow-up',
          metadataJson: null,
          createdAtMs: 250,
        },
      });

      const thread = await repository.getLarkThreadBySessionId('session_1');
      expect(thread).toBeTruthy();
      expect(thread?.rootMessageId).toBe('om_root_1');
      expect(thread?.threadId).toBe('omt_thread_1');
      expect(thread?.createdAtMs).toBe(100);
      expect(thread?.updatedAtMs).toBe(250);

      const messageRows = await repository.getLarkMessagesForThread('om_root_1');
      expect(messageRows.map((row) => row.messageId)).toEqual(['om_1', 'om_2']);
      expect(messageRows.map((row) => row.normalizedText)).toEqual(['please review this', 'follow-up']);
    } finally {
      client.close();
    }
  });

  it('updates executor/model on /new without changing session_id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_2',
        threadId: 'omt_thread_2',
        sessionId: 'session_2',
        source: 'lark',
        chatType: 'group',
        taskType: 'localagent',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 1000,
        threadUpdatedAtMs: 1000,
        message: {
          messageId: 'om_21',
          messageType: 'text',
          rawContent: '{"text":"start"}',
          normalizedText: 'start',
          metadataJson: null,
          createdAtMs: 1000,
        },
      });

      await repository.markLarkThreadNewInstance({
        sessionId: 'session_2',
        executor: 'ttcodex',
        executorModel: 'gpt-5.4',
        updatedAtMs: 1200,
      });

      const thread = await repository.getLarkThreadByThreadId('omt_thread_2');
      expect(thread?.sessionId).toBe('session_2');
      expect(thread?.executor).toBe('ttcodex');
      expect(thread?.executorModel).toBe('gpt-5.4');
      expect(thread?.updatedAtMs).toBe(1200);
    } finally {
      client.close();
    }
  });

  it('records phase reaction metadata attempts and last state on success', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_4',
        threadId: 'omt_thread_4',
        sessionId: 'session_4',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 100,
        threadUpdatedAtMs: 100,
        message: {
          messageId: 'om_41',
          messageType: 'text',
          rawContent: '{"text":"start"}',
          normalizedText: 'start',
          metadataJson: '{"event_kind":"reply"}',
          createdAtMs: 100,
        },
      });

      await repository.appendLarkPhaseReactionAttempt('om_41', {
        phase: 'queued',
        action: 'set',
        ok: true,
        at: '2026-04-05T10:00:00.000Z',
        event_id: 'evt_phase_1',
      });

      const row = await repository.getLarkMessageByMessageId('om_41');
      const metadata = JSON.parse(row?.metadataJson ?? '{}') as Record<string, unknown>;
      const phaseReactions = metadata.phase_reactions as Record<string, unknown>;

      expect(metadata.event_kind).toBe('reply');
      expect(phaseReactions.last).toEqual({
        phase: 'queued',
        applied_at: '2026-04-05T10:00:00.000Z',
        event_id: 'evt_phase_1',
      });
      expect(phaseReactions.attempts).toEqual([
        {
          phase: 'queued',
          action: 'set',
          ok: true,
          at: '2026-04-05T10:00:00.000Z',
          event_id: 'evt_phase_1',
        },
      ]);
    } finally {
      client.close();
    }
  });

  it('records phase reaction failure markers when updates fail', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_5',
        threadId: 'omt_thread_5',
        sessionId: 'session_5',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 100,
        threadUpdatedAtMs: 100,
        message: {
          messageId: 'om_51',
          messageType: 'text',
          rawContent: '{"text":"start"}',
          normalizedText: 'start',
          metadataJson: 'not-json',
          createdAtMs: 100,
        },
      });

      await repository.appendLarkPhaseReactionAttempt('om_51', {
        phase: 'completed',
        action: 'clear',
        ok: false,
        at: '2026-04-05T10:01:00.000Z',
        event_id: 'evt_phase_2',
        error: 'list reactions failed',
      });

      const row = await repository.getLarkMessageByMessageId('om_51');
      const metadata = JSON.parse(row?.metadataJson ?? '{}') as Record<string, unknown>;
      const phaseReactions = metadata.phase_reactions as Record<string, unknown>;
      const attempts = phaseReactions.attempts as Record<string, unknown>[];

      expect(phaseReactions.last).toBeUndefined();
      expect(attempts).toEqual([
        {
          phase: 'completed',
          action: 'clear',
          ok: false,
          at: '2026-04-05T10:01:00.000Z',
          event_id: 'evt_phase_2',
          error: 'list reactions failed',
        },
      ]);
    } finally {
      client.close();
    }
  });

  it('deletes lark rows by session_id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertInboundLarkMessage({
        rootMessageId: 'om_root_3',
        threadId: 'omt_thread_3',
        sessionId: 'session_3',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        threadCreatedAtMs: 2000,
        threadUpdatedAtMs: 2000,
        message: {
          messageId: 'om_31',
          messageType: 'text',
          rawContent: '{"text":"hello"}',
          normalizedText: 'hello',
          metadataJson: null,
          createdAtMs: 2000,
        },
      });

      await repository.recordOutboundLarkMessage({
        messageId: 'om_32',
        source: 'lark',
        rootMessageId: 'om_root_3',
        sessionId: 'session_3',
        threadId: 'omt_thread_3',
        messageType: 'text',
        rawContent: '{"text":"ack"}',
        normalizedText: 'ack',
        metadataJson: '{"event_kind":"reply"}',
        createdAtMs: 2100,
      });

      await repository.deleteLarkRowsBySessionId('session_3');

      const thread = await repository.getLarkThreadBySessionId('session_3');
      expect(thread).toBeNull();
      const messageRows = await repository.getLarkMessagesForThread('om_root_3');
      expect(messageRows).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('returns stale session ids older than the cutoff regardless of status', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_stale_active',
        threadId: 'omt_stale_active',
        sessionId: 'session_stale_active',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 100,
        updatedAtMs: 100,
        endedAtMs: null,
      });

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_stale_ended',
        threadId: 'omt_stale_ended',
        sessionId: 'session_stale_ended',
        source: 'lark',
        chatType: 'group',
        taskType: 'cleanup',
        executor: 'builtin',
        executorModel: 'none',
        status: 'ended',
        createdAtMs: 150,
        updatedAtMs: 150,
        endedAtMs: 150,
      });

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_fresh_active',
        threadId: 'omt_fresh_active',
        sessionId: 'session_fresh_active',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 300,
        updatedAtMs: 300,
        endedAtMs: null,
      });

      await expect(repository.getStaleLarkSessionIdsBeforeUpdatedAt(200)).resolves.toEqual([
        'session_stale_active',
        'session_stale_ended',
      ]);
    } finally {
      client.close();
    }
  });

  it('returns an empty list when no thread rows are older than the cutoff', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-lark-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'history.sqlite'),
    });

    try {
      await bootstrapLarkTables(client.connection);
      const repository = new LarkHistoryRepository(client.db);

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_fresh_1',
        threadId: 'omt_fresh_1',
        sessionId: 'session_fresh_1',
        source: 'lark',
        chatType: 'group',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 500,
        updatedAtMs: 500,
        endedAtMs: null,
      });

      await repository.upsertLarkThreadState({
        rootMessageId: 'om_root_fresh_2',
        threadId: 'omt_fresh_2',
        sessionId: 'session_fresh_2',
        source: 'lark',
        chatType: 'group',
        taskType: 'cleanup',
        executor: 'builtin',
        executorModel: 'none',
        status: 'ended',
        createdAtMs: 600,
        updatedAtMs: 600,
        endedAtMs: 600,
      });

      await expect(repository.getStaleLarkSessionIdsBeforeUpdatedAt(400)).resolves.toEqual([]);
    } finally {
      client.close();
    }
  });
});

async function bootstrapLarkTables(connection: Awaited<ReturnType<typeof createSqliteClient>>['connection']): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS lark_threads (
      root_message_id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE,
      root_session_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      chat_type TEXT,
      task_type TEXT NOT NULL,
      executor TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS lark_messages (
      message_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      root_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT,
      direction TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      message_type TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      normalized_text TEXT,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (root_message_id) REFERENCES lark_threads(root_message_id)
    )
  `);
}
