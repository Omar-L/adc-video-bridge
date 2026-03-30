import { createChildLogger } from '../utils/logger.js';
import { TokenManager } from '../auth/token-manager.js';
import { CameraStream } from './camera-stream.js';
import type { CameraConfig } from '../config.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('camera-manager');

const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * Orchestrates multiple camera stream pipelines.
 * Subscribes to TokenManager events to start/restart streams on token refresh.
 */
export class CameraManager {
  private streams = new Map<string, CameraStream>();
  private activeStarts = new Set<string>();
  private failureCount = new Map<string, number>();
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
      status[stream.cameraName] = stream.state;
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

    this.activeStarts.add(cameraId);

    try {
      log.info({ camera: stream.cameraName }, 'Starting stream with fresh token');

      // Silent fetch so dial-in retries don't trigger another handleVideoToken
      const refetchToken = async () => this.tokenManager.fetchVideoTokenSilent(cameraId);
      await stream.start(config, refetchToken);

      this.failureCount.delete(cameraId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ camera: stream.cameraName }, 'Stream failed after all retries: %s', msg);

      if (this.running) {
        const failures = this.failureCount.get(cameraId) ?? 0;
        const delay = BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)];
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
}
