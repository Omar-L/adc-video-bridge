import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';
import type { AlarmAuth } from '../auth/alarm-auth.js';
import {
  EventType,
  type AlarmEvent,
  type AlarmEventListenerEvents,
} from './types.js';
import { parseBaseEvent, parseMotionEvent } from './parse-event.js';

const log = createChildLogger('alarm-events');

const WS_TOKEN_URL = 'https://www.alarm.com/web/api/websockets/token';
const TOKEN_REFRESH_MS = 240_000;
const BACKOFF_STEPS_MS = [5_000, 10_000, 30_000, 60_000];
const EXPECTED_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1008]);

interface WsTokenResponse {
  value: string;
  metaData: { endpoint: string };
}

/**
 * Persistent WebSocket listener for Alarm.com device events.
 *
 * Emits typed events for motion, sensor changes, clip recordings, etc.
 * Automatically reconnects on disconnection.
 */
export class AlarmEventListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private running = false;

  constructor(private readonly auth: AlarmAuth) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    log.info('Stopped');
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async connect(): Promise<void> {
    this.clearTimers();
    try {
      const tokenResponse = await retry(
        () => this.auth.get<WsTokenResponse>(WS_TOKEN_URL),
        { maxAttempts: 3, label: 'ws-token' },
      );

      const token = tokenResponse.value;
      const endpoint = tokenResponse.metaData?.endpoint;

      if (!token || !endpoint) {
        throw new Error('Invalid WebSocket token response');
      }

      const wsUrl = `${endpoint}?auth=${token}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        log.info('WebSocket connected to %s', endpoint);
        this.consecutiveFailures = 0;
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          log.info('Proactive token refresh');
          this.closeAndReconnect();
        }, TOKEN_REFRESH_MS);
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        log.error('WebSocket error: %s', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        log.warn('WebSocket closed: code=%d reason=%s', code, reason.toString());
        this.ws = null;
        this.clearTimers();

        if (EXPECTED_CLOSE_CODES.has(code)) {
          this.scheduleReconnect(0);
        } else {
          this.scheduleReconnect(this.nextBackoffDelay());
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to connect: %s', error.message);
      this.emit('error', error);
      this.scheduleReconnect(this.nextBackoffDelay());
    }
  }

  private closeAndReconnect(): void {
    if (!this.running) return;

    if (this.ws) {
      // Remove listeners before close to prevent the close handler from
      // firing and triggering a duplicate reconnect.
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running) return;

    if (delayMs === 0) {
      log.info('Reconnecting immediately...');
      this.connect();
      return;
    }

    log.info('Reconnecting in %ds...', delayMs / 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private nextBackoffDelay(): number {
    const delay = BACKOFF_STEPS_MS[Math.min(this.consecutiveFailures, BACKOFF_STEPS_MS.length - 1)];
    this.consecutiveFailures++;
    return delay;
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Non-JSON message: %s', raw.slice(0, 200));
      return;
    }

    const base = parseBaseEvent(msg);
    this.emit('raw', base);

    switch (base.eventType) {
      case EventType.MOTION: {
        const motion = parseMotionEvent(base);
        log.info(
          { cameraId: motion.cameraId, rule: motion.ruleName },
          'Motion detected',
        );
        this.emit('motion', motion);
        break;
      }
      case EventType.MOTION_END:
        log.debug({ cameraId: base.cameraId }, 'Motion ended');
        this.emit('motionEnd', { ...base, eventType: EventType.MOTION_END });
        break;
      case EventType.VIDEO_CLIP:
        log.debug({ cameraId: base.cameraId }, 'Clip recorded');
        this.emit('clipRecorded', { ...base, eventType: EventType.VIDEO_CLIP });
        break;
      case EventType.SENSOR_CHANGE:
        log.debug({ cameraId: base.cameraId, value: base.eventValue }, 'Sensor change');
        this.emit('sensorChange', { ...base, eventType: EventType.SENSOR_CHANGE });
        break;
      default:
        log.debug({ eventType: base.eventType, deviceId: base.deviceId }, 'Unhandled event type');
    }
  }
}

export declare interface AlarmEventListener {
  on<E extends keyof AlarmEventListenerEvents>(event: E, listener: AlarmEventListenerEvents[E]): this;
  emit<E extends keyof AlarmEventListenerEvents>(event: E, ...args: Parameters<AlarmEventListenerEvents[E]>): boolean;
}
