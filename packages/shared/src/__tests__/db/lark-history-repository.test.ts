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
});

async function bootstrapLarkTables(connection: Awaited<ReturnType<typeof createSqliteClient>>['connection']): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS lark_threads (
      root_message_id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE,
      session_id TEXT NOT NULL UNIQUE,
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
