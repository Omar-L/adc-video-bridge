import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stub CameraStream so we can control start()/stop()/reconnect() behavior
vi.mock('./camera-stream.js', () => ({
  CameraStream: vi.fn().mockImplementation(function (_id: string, name: string) {
    return {
      cameraId: _id,
      cameraName: name,
      state: 'idle',
      onUnexpectedExit: null,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { CameraManager } from './camera-manager.js';
import { TokenManager } from '../auth/token-manager.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com',
  signallingServerToken: 'token',
  cameraAuthToken: 'auth',
  supportsAudio: false,
  supportsFullDuplex: false,
  iceServers: [],
});

/** Create a minimal TokenManager stub that extends EventEmitter. */
function createTokenManagerStub() {
  const stub = Object.assign(new EventEmitter(), {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    fetchVideoToken: vi.fn().mockResolvedValue(null),
    fetchVideoTokenSilent: vi.fn().mockResolvedValue(null),
    circuitState: vi.fn().mockReturnValue('closed' as const),
  });
  return stub as unknown as TokenManager & typeof stub;
}

describe('CameraManager backoff', () => {
  let manager: CameraManager;
  let tokenManager: ReturnType<typeof createTokenManagerStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenManager = createTokenManagerStub();
    manager = new CameraManager(tokenManager, 'rtsp://localhost:8554');
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function startWithCamera() {
    await manager.start([{ id: 'cam-1', name: 'driveway', quality: 'hd' as const }]);
  }

  function getStream(): any {
    const status = manager.getStatus();
    // Access the internal stream via the streams map
    return (manager as any).streams.get('cam-1');
  }

  it('retries with 30s delay on first failure', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValueOnce(new Error('dial-in failed'));

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0); // let handleVideoToken run

    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalledWith('cam-1');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledWith('cam-1');
  });

  it('increases delay on consecutive failures: 30s → 60s → 120s', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    // Failure 1 → 30s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);

    // Failure 2 → 60s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);

    // Failure 3 → 120s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(119_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('caps the ladder delay at 10 minutes on its last rung', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    // Failures 1-4 walk the ladder: 30s, 60s, 120s, 300s.
    for (const delay of [30_000, 60_000, 120_000, 300_000]) {
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(delay);
    }

    // Failure 5 lands on the clamp. The circuit opens on failure 6, so this is
    // the only rung where the 10-minute cap is the delay actually used.
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(599_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('resets backoff to 30s after a successful connection', async () => {
    await startWithCamera();
    const stream = getStream();

    // Fail twice to bump backoff
    stream.start.mockRejectedValue(new Error('camera offline'));
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000); // 1st failure → 30s

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); // 2nd failure → 60s

    // Now succeed
    stream.start.mockResolvedValue(undefined);
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    // Fail again — should be back to 30s, not 120s
    stream.start.mockRejectedValue(new Error('camera offline'));
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('recovers immediately when ffmpeg exits mid-stream', async () => {
    await startWithCamera();
    const stream = getStream();

    // Successful start — stream is active
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    // Simulate ffmpeg dying mid-stream
    stream.onUnexpectedExit();

    expect(tokenManager.fetchVideoToken).toHaveBeenCalledWith('cam-1');
  });

  it('does not recover on mid-stream exit after manager is stopped', async () => {
    await startWithCamera();
    const stream = getStream();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    await manager.stop();
    tokenManager.fetchVideoToken.mockClear();

    // Simulate ffmpeg dying after stop
    stream.onUnexpectedExit?.();

    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
  });

  it('uses reconnect instead of start when stream is already streaming', async () => {
    await startWithCamera();
    const stream = getStream();

    // First token → normal start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    // Stream is now active
    stream.state = 'streaming';
    stream.start.mockClear();

    // Second token → should use reconnect
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).toHaveBeenCalledOnce();
    expect(stream.start).not.toHaveBeenCalled();
  });

  it('falls back to start when reconnect fails', async () => {
    await startWithCamera();
    const stream = getStream();

    // First token → normal start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    stream.state = 'streaming';
    stream.start.mockClear();
    stream.reconnect.mockRejectedValueOnce(new Error('reconnect failed'));

    // Second token → reconnect fails, should fall back to start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).toHaveBeenCalledOnce();
    expect(stream.start).toHaveBeenCalledOnce();
  });

  it('uses start (not reconnect) when stream is in error state', async () => {
    await startWithCamera();
    const stream = getStream();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    stream.state = 'error';
    stream.start.mockClear();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).not.toHaveBeenCalled();
    expect(stream.start).toHaveBeenCalledOnce();
  });

  describe('circuit breaker', () => {
    const LADDER_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
    const FIVE_MIN = 5 * 60_000;

    /** Make the stub behave like the real fetch: a usable token is emitted. */
    function autoEmitTokens() {
      tokenManager.fetchVideoToken.mockImplementation(async (id: string) => {
        const config = makeConfig();
        tokenManager.emit('videoToken', id, config);
        return config;
      });
    }

    /**
     * Walk the ladder to its end, which is six failures and opens the circuit,
     * then consume `probes` further probes on the escalating cooldown.
     */
    async function driveUntilOpen(probes = 0) {
      const cooldowns = [FIVE_MIN, 15 * 60_000, 30 * 60_000];
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of LADDER_MS) await vi.advanceTimersByTimeAsync(delay);
      for (let i = 0; i < probes; i++) await vi.advanceTimersByTimeAsync(cooldowns[i]);
    }

    it('opens once the ladder is exhausted and says so in the status line', async () => {
      autoEmitTokens();
      await startWithCamera();
      getStream().start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();

      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });
    });

    it('collapses the retry rate: 6 attempts/hour on the ladder, 3 once open', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();
      stream.start.mockClear();

      await vi.advanceTimersByTimeAsync(60 * 60_000);

      // Probes at +5m, +20m, +50m. The saturated ladder would have retried
      // every 10 minutes, forever, and never stopped.
      expect(stream.start).toHaveBeenCalledTimes(3);
    });

    it('bounds the mid-stream recovery path, which has no backoff of its own', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen(1);
      stream.start.mockClear();

      // handleUnexpectedExit refetches immediately — no ladder, no delay. With
      // the next probe 15 minutes out, the circuit is the only thing stopping
      // a dying ffmpeg from hammering Alarm.com.
      stream.onUnexpectedExit();
      await vi.advanceTimersByTimeAsync(0);

      expect(stream.start).not.toHaveBeenCalled();
    });

    it('closes itself on the first successful probe, with no restart needed', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();

      // A camera demoted by a weak link recovers on its own once the link
      // improves, with nothing restarting the bridge, so the circuit has to
      // notice recovery by itself.
      stream.start.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(FIVE_MIN);

      expect(manager.getStatus()).toEqual({ driveway: 'idle' });

      // And the fast ladder is available again from its first rung.
      stream.start.mockRejectedValue(new Error('camera offline'));
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      stream.start.mockClear();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(stream.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.start).toHaveBeenCalledTimes(1);
    });

    it('reports an open token circuit even when the stream circuit is closed', async () => {
      await startWithCamera();
      tokenManager.circuitState.mockReturnValue('open');

      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });
    });
  });

  it('does not retry when manager is stopped', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    await manager.stop();
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
  });
});
