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

// Stub CameraStream so we can control start()/stop() behavior
vi.mock('./camera-stream.js', () => ({
  CameraStream: vi.fn().mockImplementation((_id: string, name: string) => ({
    cameraId: _id,
    cameraName: name,
    state: 'idle',
    onUnexpectedExit: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
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

  it('caps delay at 10 minutes after many failures', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    // Run through 5+ failures to exceed the backoff steps array
    for (let i = 0; i < 6; i++) {
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      tokenManager.fetchVideoToken.mockClear();
      await vi.advanceTimersByTimeAsync(600_000); // 10 min max
    }

    // 7th failure should still be capped at 10 minutes
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
