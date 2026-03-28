import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('node-alarm-dot-com', () => ({
  login: vi.fn().mockResolvedValue({
    cookie: 'test-cookie',
    ajaxKey: 'test-key',
    expires: Date.now() + 3600000,
    systems: ['12345'],
    identities: {},
  }),
  authenticatedGet: vi.fn().mockResolvedValue({}),
}));

import { AlarmAuth } from './alarm-auth.js';

describe('AlarmAuth', () => {
  let auth: AlarmAuth;

  beforeEach(() => {
    auth = new AlarmAuth('user@test.com', 'password');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isSessionFresh', () => {
    it('returns false when never logged in', () => {
      expect(auth.isSessionFresh()).toBe(false);
    });

    it('returns true when logged in recently', async () => {
      await auth.authenticate();
      expect(auth.isSessionFresh()).toBe(true);
    });

    it('returns false when session is older than 55 minutes', async () => {
      await auth.authenticate();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 55 * 60 * 1000);
      expect(auth.isSessionFresh()).toBe(false);
    });

    it('returns false after destroy()', async () => {
      await auth.authenticate();
      auth.destroy();
      expect(auth.isSessionFresh()).toBe(false);
    });
  });
});
