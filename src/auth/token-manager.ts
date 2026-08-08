import { EventEmitter } from 'node:events';
import { createChildLogger } from '../utils/logger.js';
import { retry, sleep } from '../utils/retry.js';
import { CircuitBreaker, type CircuitState } from '../utils/circuit-breaker.js';
import { AlarmAuth } from './alarm-auth.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('token-manager');

const SESSION_REFRESH_MS = 55 * 60 * 1000;
const VIDEO_TOKEN_REFRESH_MS = 600 * 1000;
/**
 * Three consecutive fetches that produce nothing usable. A fetch that *throws*
 * is retried 3× inside `retry()`, so the worst case is 9 API calls; a fetch
 * that merely returns an empty result costs one call, because `retry()` only
 * re-attempts on a thrown error.
 */
export const VIDEO_TOKEN_FAILURE_THRESHOLD = 3;
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
  private breakers = new Map<string, CircuitBreaker>();
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
   *
   * Guarded by a per-camera circuit breaker. While the circuit is open this
   * returns `null` without touching the network; the 600s timer keeps ticking
   * but only the tick after a cooldown expires reaches Alarm.com, so the
   * effective probe interval is the longer of the two.
   *
   * Note that camera-stream's dial-in loop shares this breaker — it can call
   * here up to 12 times per start attempt. That is intended: those refetches
   * are the same API call and count the same. A suppressed refetch simply
   * returns `null` and the dial-in loop reuses its existing config.
   */
  async fetchVideoTokenSilent(cameraId: string): Promise<EndToEndWebrtcConfig | null> {
    const breaker = this.breakerFor(cameraId);
    if (!breaker.tryAttempt()) {
      log.debug({ cameraId }, 'Video token fetch suppressed — circuit open');
      return null;
    }

    try {
      const config = await retry(
        () => this.fetchVideoSource(cameraId),
        { maxAttempts: 3, label: `videoToken:${cameraId}` },
      );

      if (config) {
        breaker.recordSuccess();
        return config;
      }

      // 🔑 This branch is the one that matters. A response with no end-to-end
      // WebRTC block is HTTP 200 with `errorEnum: 0` — a success by every
      // measure except the only one that counts. It does not throw and does
      // not emit `error`, so a breaker keyed on exceptions would sit closed
      // through the entire outage. Record it as the failure it is.
      breaker.recordFailure('response carried no end-to-end WebRTC configuration');
      log.warn({ cameraId }, 'No WebRTC config in response');
      return null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      breaker.recordFailure(error.message);
      log.error({ cameraId }, 'Video token fetch failed: %s', error.message);
      this.emit('error', cameraId, error);
      return null;
    }
  }

  /** Circuit state for a camera's token loop, for status reporting. */
  circuitState(cameraId: string): CircuitState {
    return this.breakers.get(cameraId)?.state ?? 'closed';
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

  private breakerFor(cameraId: string): CircuitBreaker {
    let breaker = this.breakers.get(cameraId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        label: `videoToken:${cameraId}`,
        failureThreshold: VIDEO_TOKEN_FAILURE_THRESHOLD,
      });
      this.breakers.set(cameraId, breaker);
    }
    return breaker;
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
