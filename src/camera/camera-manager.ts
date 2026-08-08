import { createChildLogger } from '../utils/logger.js';
import { TokenManager } from '../auth/token-manager.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { CameraStream } from './camera-stream.js';
import type { CameraConfig } from '../config.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('camera-manager');

const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/**
 * One failure per rung plus one: the ladder is walked to its 10-minute cap and
 * applied once before the circuit opens, ~18 minutes into a camera that will
 * not start. This is the least urgent of the three loops — its own cap already
 * bounds it to ~6 attempts/hour, and a failure here often means one sick camera
 * rather than an Alarm.com outage.
 */
export const STREAM_FAILURE_THRESHOLD = BACKOFF_STEPS_MS.length + 1;

/**
 * Orchestrates multiple camera stream pipelines.
 * Subscribes to TokenManager events to start/restart streams on token refresh.
 */
export class CameraManager {
  private streams = new Map<string, CameraStream>();
  private activeStarts = new Set<string>();
  private failureCount = new Map<string, number>();
  private breakers = new Map<string, CircuitBreaker>();
  private running = false;

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly rtspBaseUrl: string,
  ) {}

  async start(cameras: CameraConfig[]): Promise<void> {
    if (cameras.length === 0) {
      throw new Error(
        'No cameras configured. Run "npx tsx src/discover.ts" to find your camera IDs, ' +
        'then add them to config/config.yaml and config/go2rtc.yaml.',
      );
    }

    this.running = true;

    for (const cam of cameras) {
      const stream = new CameraStream(cam.id, cam.name, this.rtspBaseUrl);
      stream.onUnexpectedExit = () => this.handleUnexpectedExit(cam.id);
      this.streams.set(cam.id, stream);
    }

    this.tokenManager.on('videoToken', (cameraId, config) => {
      this.handleVideoToken(cameraId, config);
    });

    this.tokenManager.on('error', (cameraId, error) => {
      log.error({ cameraId }, 'Token error: %s', error.message);
    });

    const cameraIds = cameras.map((c) => c.id);
    await this.tokenManager.start(cameraIds);

    log.info({ cameras: cameras.map((c) => c.name) }, 'Camera manager started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.tokenManager.stop();

    const stopPromises = Array.from(this.streams.values()).map((stream) => stream.stop());
    await Promise.allSettled(stopPromises);
    this.streams.clear();

    log.info('Camera manager stopped');
  }

  getStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    for (const [id, stream] of this.streams) {
      // Surface a paused loop in the periodic status line, so an operator
      // reading the logs sees why an idle camera is not being retried.
      const paused =
        this.breakers.get(id)?.state === 'open' || this.tokenManager.circuitState(id) === 'open';
      status[stream.cameraName] = paused ? `${stream.state} (circuit open)` : stream.state;
    }
    return status;
  }

  private async handleVideoToken(cameraId: string, config: EndToEndWebrtcConfig): Promise<void> {
    const stream = this.streams.get(cameraId);
    if (!stream) {
      log.warn({ cameraId }, 'Received token for unknown camera');
      return;
    }

    // Skip if a start is already in progress (e.g., dial-in retry loop)
    if (this.activeStarts.has(cameraId)) {
      log.debug({ camera: stream.cameraName }, 'Start already in progress, skipping token event');
      return;
    }

    const breaker = this.breakerFor(cameraId);

    // If the stream is already active, do a seamless reconnect (keeps ffmpeg alive)
    if (stream.state === 'streaming') {
      this.activeStarts.add(cameraId);
      try {
        log.info({ camera: stream.cameraName }, 'Seamless reconnect with fresh token');
        await stream.reconnect(config);
        this.failureCount.delete(cameraId);
        breaker.recordSuccess();
        this.activeStarts.delete(cameraId);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ camera: stream.cameraName }, 'Reconnect failed (%s), falling back to full restart', msg);
        this.activeStarts.delete(cameraId);
      }
    }

    // A token can arrive from the 600s refresh timer as well as from the retry
    // ladder below, so the ladder's delay alone does not bound how often a
    // hopeless start is attempted. The circuit does.
    if (!breaker.tryAttempt()) {
      log.debug({ camera: stream.cameraName }, 'Stream start suppressed — circuit open');
      return;
    }

    this.activeStarts.add(cameraId);

    try {
      log.info({ camera: stream.cameraName }, 'Starting stream with fresh token');

      // Silent fetch so dial-in retries don't trigger another handleVideoToken
      const refetchToken = async () => this.tokenManager.fetchVideoTokenSilent(cameraId);
      await stream.start(config, refetchToken);

      this.failureCount.delete(cameraId);
      breaker.recordSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ camera: stream.cameraName }, 'Stream failed after all retries: %s', msg);
      breaker.recordFailure(msg);

      if (this.running) {
        const failures = this.failureCount.get(cameraId) ?? 0;
        const delay =
          breaker.state === 'open'
            ? breaker.retryAfterMs()
            : BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)];
        this.failureCount.set(cameraId, failures + 1);

        log.info({ camera: stream.cameraName, delay: delay / 1000, failures: failures + 1 }, 'Will retry in %ds', delay / 1000);
        setTimeout(() => {
          this.activeStarts.delete(cameraId);
          if (!this.running) return;
          this.tokenManager.fetchVideoToken(cameraId);
        }, delay);
        return;
      }
    }

    this.activeStarts.delete(cameraId);
  }

  private breakerFor(cameraId: string): CircuitBreaker {
    let breaker = this.breakers.get(cameraId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        label: `stream:${cameraId}`,
        failureThreshold: STREAM_FAILURE_THRESHOLD,
      });
      this.breakers.set(cameraId, breaker);
    }
    return breaker;
  }

  private handleUnexpectedExit(cameraId: string): void {
    if (!this.running) return;

    const stream = this.streams.get(cameraId);
    const name = stream?.cameraName ?? cameraId;
    log.warn({ camera: name }, 'Stream died mid-stream, fetching fresh token to recover');

    this.activeStarts.delete(cameraId);
    this.tokenManager.fetchVideoToken(cameraId);
  }
}
