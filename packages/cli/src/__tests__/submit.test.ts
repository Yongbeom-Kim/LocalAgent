import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { DEFAULT_API_URL } from '@local-agent/shared';

const mockFetch = vi.fn();
const AUTH_ENV = { API_AUTH_TOKEN: 'test-token' };

import * as submitModule from '../commands/submit';

describe('submitTask', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success with taskType and submittedAt on 201', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'test prompt',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    const result = await submitModule.submitTask({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
  });

  it('sends correct request body and headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code-review',
        payload: 'review this',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this',
      type: 'code-review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://example.com:3000',
      env: AUTH_ENV,
    });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        task_type: 'code-review',
        payload: 'review this',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('sends executor and model in the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('includes explicit session_id and context_ref when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
      sessionId: 'session-123',
      contextPlatform: 'lark',
      contextRootKey: 'om_root_123',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
        session_id: 'session-123',
        context_ref: {
          platform: 'lark',
          root_key: 'om_root_123',
        },
      }),
    });
  });

  it('rejects partial context options before sending the request', async () => {
    const result = await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
      contextPlatform: 'lark',
    });

    expect(result).toEqual({
      success: false,
      error: 'contextPlatform and contextRootKey must be provided together',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid context platforms before sending the request', async () => {
    const result = await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
      contextPlatform: 'discord' as 'lark',
      contextRootKey: 'root-1',
    });

    expect(result).toEqual({
      success: false,
      error: 'contextPlatform must be either lark or telegram',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends Authorization bearer header from explicit token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      token: 'explicit-token',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer explicit-token',
      },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('uses API_AUTH_TOKEN when explicit token is omitted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: { API_AUTH_TOKEN: 'env-token' },
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer env-token',
      },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('prefers explicit token over API_AUTH_TOKEN', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      token: 'explicit-token',
      env: { API_AUTH_TOKEN: 'env-token' },
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer explicit-token',
      },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('fails fast when auth is enabled and no token is configured', async () => {
    const result = await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: {},
    });

    expect(result).toEqual({
      success: false,
      error: 'API auth is enabled but no token is configured. Pass --token or set API_AUTH_TOKEN.',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows missing token when API_AUTH_DISABLED is 1', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code_review',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this diff',
      type: 'code_review',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: { API_AUTH_DISABLED: '1' },
    });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      }),
    });
  });

  it('returns error on HTTP 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'server busy',
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: false,
      error: '503 Service Unavailable — server busy',
    });
  });

  it('returns error on HTTP 400', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '',
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: false,
      error: '400 Bad Request',
    });
  });

  it('returns connection error when fetch throws ECONNREFUSED', async () => {
    const cause = { code: 'ECONNREFUSED' };
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: false,
      error: 'connection refused (http://localhost:3000/tasks)',
    });
  });

  it('returns generic network error when fetch throws without ECONNREFUSED', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: false,
      error: 'network error (http://localhost:3000/tasks)',
    });
  });

  it('returns invalid response error when success body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://localhost:3000',
      env: AUTH_ENV,
    });

    expect(result).toEqual({
      success: false,
      error: 'invalid response from server (non-JSON body)',
    });
  });
});

describe('registerSubmitCommand', () => {
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.API_URL;
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.API_URL;
    } else {
      process.env.API_URL = originalApiUrl;
    }
    vi.restoreAllMocks();
  });

  it('wires explicit apiUrl from CLI options into submitTask', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      [
        'submit',
        '--payload',
        'test prompt',
        '--type',
        'generic',
        '--executor',
        'claude',
        '--model',
        'sonnet',
        '--api-url',
        'http://example.com:3000',
      ],
      {
        from: 'user',
      },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: 'http://example.com:3000',
    });
    expect(logSpy).toHaveBeenCalledWith('Task submitted successfully.');
  });

  it('wires explicit token from CLI options into submitTask', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      [
        'submit',
        '--payload',
        'test prompt',
        '--type',
        'generic',
        '--executor',
        'claude',
        '--model',
        'sonnet',
        '--token',
        'explicit-token',
      ],
      {
        from: 'user',
      },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: DEFAULT_API_URL,
      token: 'explicit-token',
    });
  });

  it('passes explicit session_id through the command wiring', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      [
        'submit',
        '--payload',
        'test prompt',
        '--type',
        'generic',
        '--executor',
        'claude',
        '--model',
        'sonnet',
        '--session-id',
        'session-123',
      ],
      {
        from: 'user',
      },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: DEFAULT_API_URL,
      sessionId: 'session-123',
    });
  });

  it('passes context_ref options through the command wiring', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      [
        'submit',
        '--payload',
        'test prompt',
        '--type',
        'generic',
        '--executor',
        'claude',
        '--model',
        'sonnet',
        '--context-platform',
        'telegram',
        '--context-root-key',
        '-100456789:42',
      ],
      {
        from: 'user',
      },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: DEFAULT_API_URL,
      contextPlatform: 'telegram',
      contextRootKey: '-100456789:42',
    });
  });

  it('uses DEFAULT_API_URL when apiUrl option and API_URL env are unset', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      [
        'submit',
        '--payload',
        'test prompt',
        '--type',
        'generic',
        '--executor',
        'claude',
        '--model',
        'sonnet',
      ],
      {
        from: 'user',
      },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      executor: 'claude',
      model: 'sonnet',
      apiUrl: DEFAULT_API_URL,
    });
  });

  it('requires --type, --executor, and --model in the command wiring', async () => {
    const program = new Command();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    program.exitOverride();
    submitModule.registerSubmitCommand(program, vi.fn());

    await expect(
      program.parseAsync(['submit', '--payload', 'test'], { from: 'user' }),
    ).rejects.toThrow();
  });
});
