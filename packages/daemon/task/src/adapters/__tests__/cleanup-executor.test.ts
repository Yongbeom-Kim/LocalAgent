import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobAttempt, LarkHistoryRepository, createSqliteClient } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';
import { CleanupExecutor } from '../cleanup-executor';

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-cleanup-001',
    task_id: 'task-cleanup-001',
    task_type: 'cleanup',
    payload: 'cleanup session workspace',
    executor: 'builtin',
    executor_model: 'none',
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'session-cleanup-001',
    ...overrides,
  };
}

function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/unused-workdir',
    pluginDirs: [],
    isExistingWorkspace: false,
    ...overrides,
  };
}

describe('CleanupExecutor', () => {
  let tempBaseDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'cleanup-executor-'));
    originalDbPath = process.env.LOCAL_AGENT_DB_PATH;
    process.env.LOCAL_AGENT_DB_PATH = join(tempBaseDir, 'history.sqlite');
    await bootstrapLarkTables(process.env.LOCAL_AGENT_DB_PATH);
  });

  afterEach(() => {
    rmSync(tempBaseDir, { recursive: true, force: true });
    if (originalDbPath === undefined) {
      delete process.env.LOCAL_AGENT_DB_PATH;
    } else {
      process.env.LOCAL_AGENT_DB_PATH = originalDbPath;
    }
    vi.restoreAllMocks();
  });

  it('removes an existing session directory', async () => {
    const job = createJobAttempt();
    const sessionDir = join(tempBaseDir, job.session_id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'artifact.txt'), 'temporary artifact');

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-cleanup-001',
      status: 'success',
      exit_code: 0,
      stdout: `Removed session workspace at ${sessionDir}`,
      stderr: '',
    });
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('returns success from precheck without inspecting PATH', async () => {
    const executor = new CleanupExecutor(tempBaseDir);

    await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
  });

  it('returns success with a not-found note when the session directory is missing', async () => {
    const job = createJobAttempt({ session_id: 'session-missing-001' });
    const sessionDir = join(tempBaseDir, job.session_id);

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-missing-001',
      status: 'success',
      exit_code: 0,
      stdout: `Session workspace not found at ${sessionDir}; nothing to remove`,
      stderr: '',
    });
  });

  it('returns failure metadata when rmSync throws', async () => {
    const job = createJobAttempt({ session_id: 'session-error-001' });
    const sessionDir = join(tempBaseDir, job.session_id);
    mkdirSync(sessionDir, { recursive: true });
    const error = new Error('rm failed');
    const removeDirectory = vi.fn((pathToRemove: string) => {
      if (pathToRemove === sessionDir) {
        throw error;
      }
    });
    const executor = new CleanupExecutor(tempBaseDir, removeDirectory);

    const result = await executor.execute(job, createEnv());

    expect(removeDirectory).toHaveBeenCalledWith(sessionDir);
    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-error-001',
      status: 'failure',
      exit_code: null,
      stdout: '',
      stderr: 'rm failed',
    });
  });

  it('removes nested directory structures recursively', async () => {
    const job = createJobAttempt({ session_id: 'session-nested-001' });
    const sessionDir = join(tempBaseDir, job.session_id);
    const nestedDir = join(sessionDir, 'marketplaces', 'repo', 'plugin', 'deep');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'nested.txt'), 'nested content');

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe(`Removed session workspace at ${sessionDir}`);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('deletes lark sqlite rows for the cleaned session', async () => {
    const job = createJobAttempt({ session_id: 'session-db-cleanup-001' });
    await seedLarkThread(job.session_id);

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result.status).toBe('success');

    const client = await createSqliteClient({ dbPath: process.env.LOCAL_AGENT_DB_PATH! });
    try {
      const repository = new LarkHistoryRepository(client.db);
      expect(await repository.getLarkThreadBySessionId(job.session_id)).toBeNull();
    } finally {
      client.close();
    }
  });

  it('fails when sqlite row deletion cannot run', async () => {
    const job = createJobAttempt({ session_id: 'session-db-failure-001' });
    delete process.env.LOCAL_AGENT_DB_PATH;

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('LOCAL_AGENT_DB_PATH is required');
  });
});

async function seedLarkThread(sessionId: string): Promise<void> {
  const client = await createSqliteClient({ dbPath: process.env.LOCAL_AGENT_DB_PATH! });

  try {
    const repository = new LarkHistoryRepository(client.db);
    await repository.upsertInboundLarkMessage({
      rootMessageId: `om_root_${sessionId}`,
      threadId: `omt_thread_${sessionId}`,
      sessionId,
      source: 'lark',
      chatType: 'group',
      taskType: 'cleanup',
      executor: 'builtin',
      executorModel: 'none',
      status: 'ended',
      threadCreatedAtMs: 100,
      threadUpdatedAtMs: 100,
      message: {
        messageId: `om_msg_${sessionId}`,
        messageType: 'text',
        rawContent: '{"text":"cleanup me"}',
        normalizedText: 'cleanup me',
        metadataJson: null,
        createdAtMs: 100,
      },
    });
  } finally {
    client.close();
  }
}

async function bootstrapLarkTables(dbPath: string): Promise<void> {
  const client = await createSqliteClient({ dbPath });

  try {
    await client.connection.execute(`
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

    await client.connection.execute(`
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
  } finally {
    client.close();
  }
}
