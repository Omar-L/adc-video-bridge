import { EventEmitter } from 'node:events';
import { createChildLogger } from '../utils/logger.js';
import { retry, sleep } from '../utils/retry.js';
import { AlarmAuth } from './alarm-auth.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('token-manager');

const SESSION_REFRESH_MS = 55 * 60 * 1000;
const VIDEO_TOKEN_REFRESH_MS = 600 * 1000;
const VIDEO_SOURCE_URL =
  'https://www.alarm.com/web/api/video/videoSources/liveVideoHighestResSources/';

interface TokenManagerEvents {
  videoToken: (cameraId: string, config: EndToEndWebrtcConfig) => void;
  error: (cameraId: string, error: Error) => void;
}

/**
 * Manages session and per-camera video token refresh on timers.
 *
 * Emits:
 * - `videoToken` when a fresh video config is fetched for a camera
 * - `error` when a token fetch fails after retries
 */
export class TokenManager extends EventEmitter {
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private cameraTimers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  constructor(private readonly auth: AlarmAuth) {
    super();
  }

  /** Start managing tokens for the given camera IDs. */
  async start(cameraIds: string[]): Promise<void> {
    this.running = true;

    if (!this.auth.isSessionFresh()) {
      await this.auth.authenticate();
    }

    this.sessionTimer = setInterval(async () => {
      try {
        log.info('Refreshing ADC session...');
        await this.auth.authenticate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Session refresh failed: %s', msg);
      }
    }, SESSION_REFRESH_MS);

    for (let i = 0; i < cameraIds.length; i++) {
      const cameraId = cameraIds[i];
      await this.fetchVideoToken(cameraId);
      this.startCameraTimer(cameraId);

      if (i < cameraIds.length - 1) {
        await sleep(1000);
      }
    }
  }

  /**
   * Fetch a fresh video token for a camera and emit the `videoToken` event.
   * Used by the timer and for initial startup.
   */
  async fetchVideoToken(cameraId: string): Promise<EndToEndWebrtcConfig | null> {
    const config = await this.fetchVideoTokenSilent(cameraId);
    if (config) {
      this.emit('videoToken', cameraId, config);
    }
    return config;
  }

  /**
   * Fetch a fresh video token WITHOUT emitting events.
   * Used by camera-stream during dial-in retries to avoid restarting the stream.
   */
  async fetchVideoTokenSilent(cameraId: string): Promise<EndToEndWebrtcConfig | null> {
    try {
      const config = await retry(
        () => this.fetchVideoSource(cameraId),
        { maxAttempts: 3, label: `videoToken:${cameraId}` },
      );

      if (config) return config;

      log.warn({ cameraId }, 'No WebRTC config in response');
      return null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ cameraId }, 'Video token fetch failed: %s', error.message);
      this.emit('error', cameraId, error);
      return null;
    }
  }

  /** Stop all timers and clean up. */
  stop(): void {
    this.running = false;

    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }

    for (const [cameraId, timer] of this.cameraTimers) {
      clearInterval(timer);
      log.debug({ cameraId }, 'Stopped camera timer');
    }
    this.cameraTimers.clear();
  }

  private startCameraTimer(cameraId: string): void {
    const existing = this.cameraTimers.get(cameraId);
    if (existing) clearInterval(existing);

    const timer = setInterval(async () => {
      if (!this.running) return;
      log.debug({ cameraId }, 'Refreshing video token...');
      await this.fetchVideoToken(cameraId);
    }, VIDEO_TOKEN_REFRESH_MS);

    this.cameraTimers.set(cameraId, timer);
  }

  private async fetchVideoSource(cameraId: string): Promise<EndToEndWebrtcConfig | null> {
    const body: any = await this.auth.get(VIDEO_SOURCE_URL + cameraId);

    const topAttrs = body?.data?.attributes ?? {};
    const iceServersRaw = topAttrs.iceServers;
    const iceServers = iceServersRaw ? JSON.parse(iceServersRaw) : [];

    const included: any[] = body?.included ?? [];
    const e2eInfo = included.find(
      (inc: any) => inc.type === 'video/videoSources/endToEndWebrtcConnectionInfo',
    );

    if (!e2eInfo) return null;

    const attrs = e2eInfo.attributes;
    return {
      signallingServerUrl: attrs.signallingServerUrl,
      signallingServerToken: attrs.signallingServerToken,
      cameraAuthToken: attrs.cameraAuthToken,
      supportsAudio: attrs.supportsAudio ?? false,
      supportsFullDuplex: attrs.supportsFullDuplex ?? false,
      iceServers,
    };
  }
}

export declare interface TokenManager {
  on<E extends keyof TokenManagerEvents>(event: E, listener: TokenManagerEvents[E]): this;
  emit<E extends keyof TokenManagerEvents>(event: E, ...args: Parameters<TokenManagerEvents[E]>): boolean;
}
