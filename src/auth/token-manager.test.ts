import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { TokenManager, VIDEO_TOKEN_FAILURE_THRESHOLD } from './token-manager.js';
import type { AlarmAuth } from './alarm-auth.js';

const FIVE_MIN = 5 * 60_000;
/** `retry` uses 1s then 2s between its three attempts. */
const RETRY_LADDER_MS = 3_000;

/**
 * What Alarm.com returns for a camera it cannot reach: HTTP 200,
 * `errorEnum: 0`, and no end-to-end WebRTC block. A success by every measure
 * except the only one that counts.
 */
function noWebrtcResponse() {
  return {
    // `iceServers` arrives as a JSON *string*, not an array — the shape the
    // parser actually has to cope with.
    data: { attributes: { iceServers: '[]' } },
    included: [
      { type: 'video/videoSources/proxyWebrtcConnectionInfo', attributes: { proxyStreamTimeoutTime: 180 } },
    ],
  };
}

function usableResponse() {
  return {
    data: { attributes: { iceServers: '[]' } },
    included: [
      {
        type: 'video/videoSources/endToEndWebrtcConnectionInfo',
        attributes: {
          signallingServerUrl: 'wss://signal.example.com',
          signallingServerToken: 'signal-token',
          cameraAuthToken: 'camera-auth-token',
        },
      },
    ],
  };
}

function createAuthStub() {
  return {
    get: vi.fn().mockResolvedValue(usableResponse()),
    isSessionFresh: vi.fn().mockReturnValue(true),
    authenticate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TokenManager circuit breaker', () => {
  let manager: TokenManager;
  let auth: ReturnType<typeof createAuthStub>;
  let emittedErrors: Error[];

  beforeEach(() => {
    vi.useFakeTimers();
    auth = createAuthStub();
    manager = new TokenManager(auth as unknown as AlarmAuth);
    emittedErrors = [];
    // EventEmitter throws on an 'error' event with no listener.
    manager.on('error', (_cameraId, error) => emittedErrors.push(error));
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Exhaust the breaker with responses that carry no WebRTC configuration. */
  async function failUntilOpen(cameraId = 'cam-1') {
    auth.get.mockResolvedValue(noWebrtcResponse());
    for (let i = 0; i < VIDEO_TOKEN_FAILURE_THRESHOLD; i++) {
      await manager.fetchVideoTokenSilent(cameraId);
    }
  }

  it('trips on responses that produce nothing usable without ever throwing', async () => {
    await failUntilOpen();

    // The whole point. Nothing threw, no 'error' event was emitted, and every
    // call looked like a success returning nothing — which is exactly what a
    // seven-hour outage looked like from inside this code. A breaker keyed on
    // exceptions would still be closed here.
    expect(emittedErrors).toHaveLength(0);
    expect(manager.circuitState('cam-1')).toBe('open');
  });

  it('stops calling Alarm.com once open', async () => {
    await failUntilOpen();
    auth.get.mockClear();

    await expect(manager.fetchVideoTokenSilent('cam-1')).resolves.toBeNull();

    expect(auth.get).not.toHaveBeenCalled();
  });

  it('probes after the cooldown and closes on the first usable response', async () => {
    await failUntilOpen();

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    auth.get.mockResolvedValue(usableResponse());

    await expect(manager.fetchVideoTokenSilent('cam-1')).resolves.toMatchObject({
      cameraAuthToken: 'camera-auth-token',
    });
    expect(manager.circuitState('cam-1')).toBe('closed');
  });

  it('does not emit videoToken while suppressed, and emits again once closed', async () => {
    const tokens: string[] = [];
    manager.on('videoToken', (cameraId) => tokens.push(cameraId));

    await failUntilOpen();
    await manager.fetchVideoToken('cam-1');
    expect(tokens).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    auth.get.mockResolvedValue(usableResponse());
    await manager.fetchVideoToken('cam-1');

    expect(tokens).toEqual(['cam-1']);
  });

  it('counts thrown errors as well as empty results', async () => {
    auth.get.mockRejectedValue(new Error('ECONNRESET'));

    for (let i = 0; i < VIDEO_TOKEN_FAILURE_THRESHOLD; i++) {
      const pending = manager.fetchVideoTokenSilent('cam-1');
      await vi.advanceTimersByTimeAsync(RETRY_LADDER_MS);
      await pending;
    }

    expect(emittedErrors).toHaveLength(VIDEO_TOKEN_FAILURE_THRESHOLD);
    expect(manager.circuitState('cam-1')).toBe('open');
  });

  it('keeps circuits per camera, so one sick camera does not pause the others', async () => {
    await failUntilOpen('cam-1');

    expect(manager.circuitState('cam-1')).toBe('open');
    expect(manager.circuitState('cam-2')).toBe('closed');

    auth.get.mockResolvedValue(usableResponse());
    await expect(manager.fetchVideoTokenSilent('cam-2')).resolves.not.toBeNull();
  });

  it('reports a closed circuit for a camera that has never been fetched', () => {
    expect(manager.circuitState('unknown')).toBe('closed');
  });
});
