import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { retry, sleep } from './retry.js';

describe('sleep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after the specified delay', async () => {
    const promise = sleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('retry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and returns on success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const promise = retry(fn, { baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws last error after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const promise = retry(fn, { maxAttempts: 2, baseDelayMs: 100 });
    const assertion = expect(promise).rejects.toThrow('always fails');
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defaults to 3 max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retry(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    const assertion = expect(promise).rejects.toThrow('fail');
    await vi.advanceTimersByTimeAsync(100); // attempt 2
    await vi.advanceTimersByTimeAsync(200); // attempt 3

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps non-Error thrown values in Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    const promise = retry(fn, { maxAttempts: 1 });

    await expect(promise).rejects.toThrow('string error');
  });

  it('applies exponential backoff capped by maxDelayMs', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retry(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 300,
    });
    const assertion = expect(promise).rejects.toThrow();

    // Attempt 1 fails → delay 100ms (100 * 2^0)
    await vi.advanceTimersByTimeAsync(100);
    // Attempt 2 fails → delay 200ms (100 * 2^1)
    await vi.advanceTimersByTimeAsync(200);
    // Attempt 3 fails → delay 300ms (min(400, 300) capped)
    await vi.advanceTimersByTimeAsync(300);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('preserves return type (generic)', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result: number = await retry(fn);
    expect(result).toBe(42);
  });
});
