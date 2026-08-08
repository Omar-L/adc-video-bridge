import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockWebSocket, getInstances, resetInstances } = vi.hoisted(() => {
  // Must be self-contained — no imports from outer scope at hoist time
  const { EventEmitter: EE } = require('node:events');

  let instances: any[] = [];

  class MockWebSocket extends EE {
    close = vi.fn();
    readyState = 1;
    url: string;

    constructor(url: string) {
      super();
      this.url = url;
      instances.push(this);
    }
  }

  return {
    MockWebSocket,
    getInstances: () => instances,
    resetInstances: () => { instances = []; },
  };
});

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

vi.mock('../utils/retry.js', () => ({
  retry: async (fn: () => Promise<unknown>) => fn(),
}));

import { AlarmEventListener } from './alarm-event-listener.js';
import type { AlarmAuth } from '../auth/alarm-auth.js';

type AuthStub = ReturnType<typeof createAuthStub>;

const TOKEN_REFRESH_MS = 240_000;
/** The listener's own backoff ladder — five rungs is EVENT_FAILURE_THRESHOLD. */
const LADDER_MS = [5_000, 10_000, 30_000, 60_000];
const FIVE_MIN = 5 * 60_000;

function createAuthStub() {
  return {
    get: vi.fn().mockResolvedValue({
      value: 'ws-token-123',
      metaData: { endpoint: 'wss://events.alarm.com' },
    }),
  };
}

function openLatestWs() {
  const instances = getInstances();
  const ws = instances[instances.length - 1];
  ws.emit('open');
  return ws;
}

function closeWs(ws: any, code: number, reason = ''): void {
  ws.emit('close', code, Buffer.from(reason));
}

describe('AlarmEventListener reconnection', () => {
  let listener: AlarmEventListener;
  let auth: AuthStub;

  beforeEach(() => {
    vi.useFakeTimers();
    resetInstances();
    auth = createAuthStub();
    listener = new AlarmEventListener(auth as unknown as AlarmAuth);
  });

  afterEach(() => {
    listener.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('connects to WS with token from auth.get()', async () => {
    await listener.start();

    expect(auth.get).toHaveBeenCalledTimes(1);
    expect(getInstances()).toHaveLength(1);
    expect(getInstances()[0].url).toBe('wss://events.alarm.com?auth=ws-token-123');
  });

  it('reconnects immediately on code 1008 (token expired)', async () => {
    await listener.start();
    const ws1 = openLatestWs();

    closeWs(ws1, 1008, 'Policy Violation');
    // Immediate reconnect — no timer needed
    await vi.advanceTimersByTimeAsync(0);

    expect(getInstances()).toHaveLength(2);
    expect(auth.get).toHaveBeenCalledTimes(2);
  });

  it('reconnects immediately on code 1000 (normal close)', async () => {
    await listener.start();
    const ws1 = openLatestWs();

    closeWs(ws1, 1000, 'Normal Closure');
    await vi.advanceTimersByTimeAsync(0);

    expect(getInstances()).toHaveLength(2);
  });

  it('applies exponential backoff on unexpected close codes', async () => {
    await listener.start();

    // Close without open — simulates connection rejected before handshake
    // Failure 1 → 5s
    closeWs(getInstances()[0], 1006);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getInstances()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(2);

    // Failure 2 → 10s
    closeWs(getInstances()[1], 1006);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(getInstances()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(3);

    // Failure 3 → 30s
    closeWs(getInstances()[2], 1006);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(getInstances()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(4);

    // Failure 4 → 60s (the ladder's cap)
    closeWs(getInstances()[3], 1006);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getInstances()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(5);

    // Failure 5 hits EVENT_FAILURE_THRESHOLD and opens the circuit, so the
    // ladder's 60s cap no longer applies — see the circuit breaker suite below.
    expect(listener.circuitState).toBe('closed');
    closeWs(getInstances()[4], 1006);
    expect(listener.circuitState).toBe('open');
  });

  it('resets backoff counter after successful connection', async () => {
    await listener.start();

    // Fail twice to bump backoff to 10s
    const ws1 = openLatestWs();
    closeWs(ws1, 1006);
    await vi.advanceTimersByTimeAsync(5_000); // 5s backoff

    const ws2 = openLatestWs();
    closeWs(ws2, 1006);
    await vi.advanceTimersByTimeAsync(10_000); // 10s backoff

    // Succeed — this should reset backoff
    const ws3 = openLatestWs();

    // Now fail again — should be back to 5s, not 30s
    closeWs(ws3, 1006);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getInstances()).toHaveLength(3); // no new ws yet
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(4); // reconnected at 5s
  });

  it('applies backoff when connect() throws', async () => {
    listener.on('error', () => {}); // prevent unhandled error event
    auth.get.mockRejectedValueOnce(new Error('network error'));

    await listener.start(); // connect() fails, schedules backoff

    // Should have 0 WS instances (token fetch failed before WS created)
    expect(getInstances()).toHaveLength(0);

    // First failure → 5s backoff
    auth.get.mockResolvedValue({
      value: 'ws-token-456',
      metaData: { endpoint: 'wss://events.alarm.com' },
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(getInstances()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(1);
  });

  it('schedules proactive refresh at 4 minutes', async () => {
    await listener.start();
    openLatestWs();

    expect(getInstances()).toHaveLength(1);

    // Advance to just before refresh
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS - 1);
    expect(getInstances()).toHaveLength(1);

    // Advance past refresh point
    await vi.advanceTimersByTimeAsync(1);
    // Old WS closed, new connection initiated
    expect(getInstances()[0].close).toHaveBeenCalled();
    expect(getInstances()).toHaveLength(2);
  });

  it('clears refresh timer on close before it fires', async () => {
    await listener.start();
    const ws1 = openLatestWs();

    // Close after 2 minutes (before the 4-minute refresh)
    await vi.advanceTimersByTimeAsync(120_000);
    closeWs(ws1, 1008);
    await vi.advanceTimersByTimeAsync(0); // immediate reconnect

    expect(getInstances()).toHaveLength(2);
    const ws2 = openLatestWs();

    // Advance past the original 4-minute mark — should NOT trigger a second refresh
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS);
    // Only the new ws2's refresh timer should have fired, not the old one
    expect(getInstances()).toHaveLength(3);
    expect(ws2.close).toHaveBeenCalled();
  });

  it('does not reconnect when stopped', async () => {
    await listener.start();
    const ws1 = openLatestWs();

    listener.stop();
    closeWs(ws1, 1008);
    await vi.advanceTimersByTimeAsync(60_000);

    // Only the original WS, no reconnect
    expect(getInstances()).toHaveLength(1);
  });

  it('stop() clears both timers and closes WS', async () => {
    await listener.start();
    const ws1 = openLatestWs();

    listener.stop();

    expect(ws1.close).toHaveBeenCalled();

    // Neither refresh nor reconnect timers should fire
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS + 60_000);
    expect(getInstances()).toHaveLength(1);
  });

  it('proactive refresh does not reconnect after stop()', async () => {
    await listener.start();
    openLatestWs();

    // Advance to just before the refresh timer fires
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS - 1);
    listener.stop();

    // Advance past the refresh point
    await vi.advanceTimersByTimeAsync(1);
    expect(getInstances()).toHaveLength(1);
  });

  describe('circuit breaker', () => {
    /** Drive the listener through five handshakes that never reach `open`. */
    async function failUntilOpen() {
      for (const delay of LADDER_MS) {
        closeWs(getInstances()[getInstances().length - 1], 1006);
        await vi.advanceTimersByTimeAsync(delay);
      }
      closeWs(getInstances()[getInstances().length - 1], 1006);
    }

    it('opens after five handshake failures and abandons the fast ladder', async () => {
      await listener.start();
      await failUntilOpen();

      expect(listener.circuitState).toBe('open');
      expect(getInstances()).toHaveLength(5);

      // The ladder would have reconnected at 60s. The circuit does not.
      await vi.advanceTimersByTimeAsync(FIVE_MIN - 1);
      expect(getInstances()).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(getInstances()).toHaveLength(6);
    });

    it('escalates the cooldown when a probe also fails', async () => {
      await listener.start();
      await failUntilOpen();

      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      expect(getInstances()).toHaveLength(6);

      // Probe failed → next probe is 15 minutes out, not another 5.
      closeWs(getInstances()[5], 1006);
      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      expect(getInstances()).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(getInstances()).toHaveLength(7);
    });

    it('closes on the first successful probe and restores the fast ladder', async () => {
      await listener.start();
      await failUntilOpen();

      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      openLatestWs();

      expect(listener.circuitState).toBe('closed');

      // Back on the 5s first rung — a breaker that needed a restart to clear
      // would have kept the listener dark instead.
      closeWs(getInstances()[5], 1006);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(getInstances()).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(getInstances()).toHaveLength(7);
    });

    it('does not open while sockets keep opening, however often they drop', async () => {
      await listener.start();

      for (let i = 0; i < 10; i++) {
        const ws = openLatestWs();
        closeWs(ws, 1006);
        await vi.advanceTimersByTimeAsync(5_000);
      }

      // Each socket reached `open`, so Alarm.com is answering. Flapping is a
      // different fault from an outage and must not pause the loop.
      expect(listener.circuitState).toBe('closed');
      expect(getInstances()).toHaveLength(11);
    });

    it('counts token failures that never reach a socket, and cuts the call rate', async () => {
      listener.on('error', () => {}); // prevent unhandled error event
      auth.get.mockRejectedValue(new Error('network error'));

      await listener.start();
      for (const delay of LADDER_MS) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      // Five attempts inside ~105 seconds — the measured ~60/hour rate.
      expect(listener.circuitState).toBe('open');
      expect(auth.get).toHaveBeenCalledTimes(5);
      expect(getInstances()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(FIVE_MIN - 1);
      expect(auth.get).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(auth.get).toHaveBeenCalledTimes(6);
    });
  });
});
