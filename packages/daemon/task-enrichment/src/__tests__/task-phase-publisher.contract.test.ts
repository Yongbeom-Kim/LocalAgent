import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildApiAuthHeaders, type Task } from '@local-agent/shared';
import { TaskPhasePublisher } from '../adapters/task-phase-publisher';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    submitted_at: '2026-03-29T00:00:00.000Z',
    session_id: 'phase-session-id',
    executor: 'claude',
    executor_model: 'sonnet',
    ...overrides,
  };
}

describe('TaskPhasePublisher contract', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('always includes session_id in phase events', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    const publisher = new TaskPhasePublisher('http://localhost:3000', 'daemon-token');

    await publisher.publish(createTask(), 'queued');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/results',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiAuthHeaders('daemon-token'),
        },
      }),
    );

    const [, request] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(request.body)).toEqual({
      event_kind: 'phase',
      task_id: 'task-123',
      task_type: 'code_review',
      session_id: 'phase-session-id',
      phase: 'queued',
      metadata: { emitted_by: 'task-enrichment' },
    });
  });
});
