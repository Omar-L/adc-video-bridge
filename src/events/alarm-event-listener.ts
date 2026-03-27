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
const RECONNECT_DELAY_MS = 30_000;

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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    log.info('Stopped');
  }

  private async connect(): Promise<void> {
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
        this.scheduleReconnect();
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to connect: %s', error.message);
      this.emit('error', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    log.info('Reconnecting in %ds...', RECONNECT_DELAY_MS / 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
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
