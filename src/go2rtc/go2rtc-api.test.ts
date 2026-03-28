import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { Go2rtcApi } from './go2rtc-api.js';

describe('Go2rtcApi', () => {
  let api: Go2rtcApi;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    api = new Go2rtcApi('http://localhost:1984');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('isHealthy', () => {
    it('returns true when API responds with 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      expect(await api.isHealthy()).toBe(true);
    });

    it('returns false when API responds with 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await api.isHealthy()).toBe(false);
    });

    it('returns false when network error occurs', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await api.isHealthy()).toBe(false);
    });
  });

  describe('getStreams', () => {
    it('returns parsed JSON on success', async () => {
      const streams = { driveway: {} };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(streams),
      });
      expect(await api.getStreams()).toEqual(streams);
    });

    it('throws on non-OK response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      await expect(api.getStreams()).rejects.toThrow();
    });

    it('throws on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(api.getStreams()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('waitReady', () => {
    it('resolves immediately when already healthy', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      await expect(api.waitReady()).resolves.toBeUndefined();
    });

    it('resolves when becomes healthy during polling', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: callCount >= 3 });
      });

      const promise = api.waitReady(10_000);
      await vi.advanceTimersByTimeAsync(1000); // poll 2
      await vi.advanceTimersByTimeAsync(1000); // poll 3 (healthy)
      await expect(promise).resolves.toBeUndefined();
    });

    it('throws when timeout is reached', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

      const promise = api.waitReady(3000);
      // Attach a no-op rejection handler immediately to prevent unhandled rejection
      promise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).rejects.toThrow();
    });
  });
});
