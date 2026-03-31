import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('werift', () => ({
  RTCPeerConnection: vi.fn(),
  RTCRtpCodecParameters: vi.fn(),
}));

vi.mock('../signaling/signaling-client.js', () => ({
  SignalingClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    sendAnswer: vi.fn(),
    sendIceCandidate: vi.fn(),
  })),
}));

vi.mock('node:dgram', () => ({
  createSocket: vi.fn().mockReturnValue({
    bind: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../utils/retry.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { CameraStream } from './camera-stream.js';
import { SignalingClient } from '../signaling/signaling-client.js';
import { sleep } from '../utils/retry.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com',
  signallingServerToken: 'token',
  cameraAuthToken: 'auth',
  supportsAudio: false,
  supportsFullDuplex: false,
  iceServers: [],
});

describe('CameraStream.start', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns successfully when tryConnect succeeds on first attempt', async () => {
    vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(1);
  });

  it('retries on dial-in error and succeeds on subsequent attempt', async () => {
    const tryConnect = vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect(tryConnect).toHaveBeenCalledTimes(2);
  });

  it('throws and sets state to error after exhausting all dial-in retries', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue(new Error('Camera has not yet dialed in'));

    await expect(stream.start(makeConfig())).rejects.toThrow(
      'Camera has not yet dialed in',
    );
    expect(stream.state).toBe('error');
  });

  it('throws immediately on non-dial-in errors without retrying', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue(new Error('Connection refused'));

    await expect(stream.start(makeConfig())).rejects.toThrow('Connection refused');
    expect(stream.state).toBe('error');
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(1);
  });

  it('calls refetchToken between dial-in retries and uses fresh config', async () => {
    const freshConfig = makeConfig();
    freshConfig.signallingServerToken = 'fresh-token';
    const refetchToken = vi.fn().mockResolvedValue(freshConfig);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(makeConfig(), refetchToken);

    expect(refetchToken).toHaveBeenCalledTimes(1);
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(2);
    expect((stream as any).tryConnect).toHaveBeenLastCalledWith(freshConfig);
  });

  it('keeps original config when refetchToken returns null', async () => {
    const originalConfig = makeConfig();
    const refetchToken = vi.fn().mockResolvedValue(null);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(originalConfig, refetchToken);

    expect(refetchToken).toHaveBeenCalledTimes(1);
    expect((stream as any).tryConnect).toHaveBeenLastCalledWith(originalConfig);
  });

  it('handles non-Error thrown values from tryConnect', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue('string error');

    await expect(stream.start(makeConfig())).rejects.toBe('string error');
    expect(stream.state).toBe('error');
  });

  it('uses longer delay (15s) for early attempts and shorter (10s) for later', async () => {
    const mockedSleep = vi.mocked(sleep);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 1
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 2
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 3
      .mockResolvedValue(undefined); // attempt 4

    await stream.start(makeConfig());

    expect(mockedSleep).toHaveBeenCalledTimes(3);
    expect(mockedSleep).toHaveBeenNthCalledWith(1, 15_000); // attempt 1 → 15s
    expect(mockedSleep).toHaveBeenNthCalledWith(2, 15_000); // attempt 2 → 15s
    expect(mockedSleep).toHaveBeenNthCalledWith(3, 10_000); // attempt 3 → 10s
  });

  it('calls stop() to clean up between dial-in retries', async () => {
    const stopSpy = vi.spyOn(stream, 'stop').mockResolvedValue(undefined);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(makeConfig());

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('retries without refetchToken when none is provided', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(3);
  });

  it('propagates error when refetchToken itself throws', async () => {
    const refetchToken = vi.fn().mockRejectedValue(new Error('auth expired'));

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'));

    await expect(stream.start(makeConfig(), refetchToken)).rejects.toThrow('auth expired');
  });
});

describe('CameraStream.reconnect', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setupReconnectMocks(stream: CameraStream) {
    // Stub internal methods that depend on werift mocks
    vi.spyOn(stream as any, 'createPeerConnection').mockReturnValue({});
    vi.spyOn(stream as any, 'setupPeerConnection').mockImplementation(() => {});
    vi.spyOn(stream as any, 'registerPostSessionHandlers').mockImplementation(() => {});
  }

  function mockSignalingToSucceed() {
    vi.mocked(SignalingClient).mockImplementation(() => ({
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sessionStarted') setTimeout(handler, 0);
      }),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      sendAnswer: vi.fn(),
      sendIceCandidate: vi.fn(),
    }) as any);
  }

  it('does not kill ffmpeg or videoSocket during reconnect', async () => {
    const mockFfmpeg = { kill: vi.fn(), on: vi.fn() };
    const mockSocket = { close: vi.fn(), send: vi.fn() };

    (stream as any).ffmpeg = mockFfmpeg;
    (stream as any).videoSocket = mockSocket;
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks(stream);
    mockSignalingToSucceed();

    await stream.reconnect(makeConfig());

    expect(mockFfmpeg.kill).not.toHaveBeenCalled();
    expect(mockSocket.close).not.toHaveBeenCalled();
  });

  it('closes old PC during reconnect', async () => {
    const mockPcClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).pc = { close: mockPcClose };
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks(stream);
    mockSignalingToSucceed();

    await stream.reconnect(makeConfig());

    expect(mockPcClose).toHaveBeenCalled();
  });

  it('sets state to connecting during reconnect', async () => {
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    let capturedState: string | undefined;

    setupReconnectMocks(stream);

    vi.mocked(SignalingClient).mockImplementation(() => ({
      on: vi.fn((event: string, handler: any) => {
        if (event === 'sessionStarted') {
          capturedState = stream.state;
          setTimeout(handler, 0);
        }
      }),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      sendAnswer: vi.fn(),
      sendIceCandidate: vi.fn(),
    }) as any);

    await stream.reconnect(makeConfig());

    expect(capturedState).toBe('connecting');
  });

  it('throws when signaling fails during reconnect', async () => {
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks(stream);

    vi.mocked(SignalingClient).mockImplementation(() => ({
      on: vi.fn((event: string, handler: any) => {
        if (event === 'error') setTimeout(() => handler(new Error('signaling failed')), 0);
      }),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      sendAnswer: vi.fn(),
      sendIceCandidate: vi.fn(),
    }) as any);

    await expect(stream.reconnect(makeConfig())).rejects.toThrow('signaling failed');
    expect(stream.state).toBe('error');
  });
});

describe('CameraStream ffmpeg mid-stream exit recovery', () => {
  let stream: CameraStream;
  let exitHandler: (code: number | null) => void;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');

    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: any) => {
        if (event === 'exit') exitHandler = handler;
      }),
      kill: vi.fn(),
    } as any);

    (stream as any).startFfmpeg();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets state to error when ffmpeg exits while streaming', () => {
    exitHandler(1);

    expect(stream.state).toBe('error');
  });

  it('invokes onUnexpectedExit callback when ffmpeg exits while streaming', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;

    exitHandler(0);

    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not invoke callback when ffmpeg exits during idle/connecting state', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;
    (stream as any)._state = 'idle';

    exitHandler(0);

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not set state to error when stream is already idle', () => {
    (stream as any)._state = 'idle';

    exitHandler(0);

    expect(stream.state).toBe('idle');
  });
});

describe('CameraStream ffmpeg SDP', () => {
  let stream: CameraStream;
  let stdinWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');

    // Allocate a port so startFfmpeg doesn't bail
    (stream as any).videoPort = 12345;

    // Mock spawn to capture what gets written to ffmpeg's stdin
    stdinWrite = vi.fn();
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: stdinWrite, end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes parsed h264Fmtp in ffmpeg SDP', () => {
    (stream as any).h264Fmtp = 'packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dA==,aO48gA==';

    (stream as any).startFfmpeg();

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dA==,aO48gA=='),
    );
  });

  it('falls back to default fmtp when h264Fmtp is null', () => {
    (stream as any).h264Fmtp = null;

    (stream as any).startFfmpeg();

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1'),
    );
    expect(stdinWrite).not.toHaveBeenCalledWith(
      expect.stringContaining('profile-level-id'),
    );
  });

  it('prepends packetization-mode=1 when missing from camera fmtp', () => {
    (stream as any).h264Fmtp = 'profile-level-id=4d001f';

    (stream as any).startFfmpeg();

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1;profile-level-id=4d001f'),
    );
  });

  it('stop() resets h264Fmtp to null', async () => {
    (stream as any).h264Fmtp = 'packetization-mode=1;profile-level-id=4d001f';

    await stream.stop();

    expect((stream as any).h264Fmtp).toBeNull();
  });
});
