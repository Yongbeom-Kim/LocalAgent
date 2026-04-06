import { describe, expect, it, vi } from 'vitest';
import { CancellationRegistry } from '../cancellation-registry';

describe('CancellationRegistry', () => {
  it('registers a running job and clears it on completion', () => {
    const registry = new CancellationRegistry();

    const registration = registry.register('session-1', 'job-1');
    expect(registry.hasRunningJob('session-1')).toBe(true);

    registration.clear();
    expect(registry.hasRunningJob('session-1')).toBe(false);
  });

  it('requests cancellation once and suppresses duplicate side effects', () => {
    const registry = new CancellationRegistry();
    const cancel = vi.fn();

    const registration = registry.register('session-1', 'job-1');
    registration.attachCancellationHandle({ cancel });

    expect(registry.requestCancellation('session-1')).toEqual({ kind: 'requested', jobId: 'job-1' });
    expect(registry.requestCancellation('session-1')).toEqual({ kind: 'already_requested', jobId: 'job-1' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('applies cancellation immediately when the handle attaches after the request', () => {
    const registry = new CancellationRegistry();
    const cancel = vi.fn();

    const registration = registry.register('session-1', 'job-1');
    expect(registry.requestCancellation('session-1')).toEqual({ kind: 'requested', jobId: 'job-1' });

    registration.attachCancellationHandle({ cancel });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registration.isCancellationRequested()).toBe(true);
    expect(registration.hasCancellationHandle()).toBe(true);
  });

  it('returns not_running when no active job exists for the session', () => {
    const registry = new CancellationRegistry();
    expect(registry.requestCancellation('missing-session')).toEqual({ kind: 'not_running' });
  });
});
