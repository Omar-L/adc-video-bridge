import { createChildLogger } from '../utils/logger.js';
import { AlarmAuth } from '../auth/alarm-auth.js';
import { TokenManager } from '../auth/token-manager.js';
import { CameraStream } from './camera-stream.js';
import type { CameraConfig } from '../config.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('camera-manager');

const RESTART_DELAY_MS = 30_000;

/**
 * Orchestrates multiple camera stream pipelines.
 * Subscribes to TokenManager events to start/restart streams on token refresh.
 */
export class CameraManager {
  private streams = new Map<string, CameraStream>();
  private activeStarts = new Set<string>();
  private running = false;

  constructor(
    private readonly auth: AlarmAuth,
    private readonly tokenManager: TokenManager,
    private readonly rtspBaseUrl: string,
  ) {}

  async start(cameras: CameraConfig[]): Promise<void> {
    this.running = true;

    let cameraConfigs = cameras;

    if (cameraConfigs.length === 0) {
      log.info('No cameras configured, auto-discovering...');
      const discovered = await this.auth.getCameraList();
      cameraConfigs = discovered
        .filter((c) => c.supportsLiveView)
        .map((c) => ({
          id: c.id,
          name: c.description.toLowerCase().replace(/\s+/g, '-') || `camera-${c.id}`,
          quality: 'hd' as const,
        }));
      log.info({ count: cameraConfigs.length }, 'Discovered cameras');
    }

    for (const cam of cameraConfigs) {
      const stream = new CameraStream(cam.id, cam.name, this.rtspBaseUrl);
      this.streams.set(cam.id, stream);
    }

    this.tokenManager.on('videoToken', (cameraId, config) => {
      this.handleVideoToken(cameraId, config);
    });

    this.tokenManager.on('error', (cameraId, error) => {
      log.error({ cameraId }, 'Token error: %s', error.message);
    });

    const cameraIds = cameraConfigs.map((c) => c.id);
    await this.tokenManager.start(cameraIds);

    log.info({ cameras: cameraConfigs.map((c) => c.name) }, 'Camera manager started');
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ camera: stream.cameraName }, 'Stream failed after all retries: %s', msg);

      if (this.running) {
        log.info({ camera: stream.cameraName }, 'Will retry in %ds', RESTART_DELAY_MS / 1000);
        setTimeout(() => {
          this.activeStarts.delete(cameraId);
          if (!this.running) return;
          this.tokenManager.fetchVideoToken(cameraId);
        }, RESTART_DELAY_MS);
        return;
      }
    }

    this.activeStarts.delete(cameraId);
  }
}
