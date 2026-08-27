import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import type { RTCSessionDescriptionLike, RTCIceCandidateLike } from '../types.js';

const log = createChildLogger('signaling');

interface SignalingClientEvents {
  sdpOffer: (offer: RTCSessionDescriptionLike, from: string, to: string) => void;
  iceCandidate: (candidate: RTCIceCandidateLike, from: string) => void;
  sessionStarted: () => void;
  connected: () => void;
  closed: (code: number, reason: string) => void;
  error: (error: Error) => void;
}

type SignalingState = 'disconnected' | 'connecting' | 'hello' | 'session' | 'streaming';

/**
 * WebSocket client for the Alarm.com camera signaling protocol.
 *
 * Protocol (from alarm-webrtc-card.js):
 * 1. Connect to `${signallingServerUrl}/${signallingServerToken}`
 * 2. Send "HELLO 2.0.1"
 * 3. Receive "HELLO ..."
 * 4. Send "START_SESSION <cameraAuthToken>"
 * 5. Receive "SESSION_STARTED"
 * 6. Receive JSON { from, to, sdp: { type: "offer", sdp: "..." } }
 * 7. Send JSON { to, from, sdp: { type: "answer", sdp: "..." } }
 * 8. Exchange ICE candidates as { to, ice: candidate }
 */
export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: SignalingState = 'disconnected';
  private remoteId: string | null = null;
  private localId: string | null = null;

  constructor(private readonly cameraName: string) {
    super();
  }

  get isConnected(): boolean {
    return this.state === 'streaming' || this.state === 'session';
  }

  /**
   * Connect to the signaling server and perform the HELLO + START_SESSION handshake.
   */
  async connect(
    signallingServerUrl: string,
    signallingServerToken: string,
    cameraAuthToken: string,
  ): Promise<void> {
    if (this.ws) {
      this.close();
    }

    this.state = 'connecting';
    const wsUrl = `${signallingServerUrl}/${signallingServerToken}`;
    log.info({ camera: this.cameraName }, 'Connecting to signaling server...');

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      const timeout = setTimeout(() => {
        reject(new Error('Signaling connection timeout (30s)'));
        if (this.ws === socket) this.close();
      }, 30_000);

      socket.on('open', () => {
        if (this.ws !== socket) return;
        log.debug({ camera: this.cameraName }, 'WebSocket connected, sending HELLO');
        this.state = 'hello';
        socket.send('HELLO 2.0.1');
      });

      socket.on('message', (data: WebSocket.Data) => {
        if (this.ws !== socket) return;
        const msg = data.toString();
        this.handleMessage(msg, cameraAuthToken, resolve, clearTimeoutFn);
      });

      socket.on('close', (code, reason) => {
        clearTimeout(timeout);
        if (this.ws !== socket) return;
        const reasonStr = reason.toString();
        log.info({ camera: this.cameraName, code, reason: reasonStr }, 'WebSocket closed');
        this.ws = null;
        this.state = 'disconnected';
        this.emit('closed', code, reasonStr);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);

        // Closing a WebSocket while it is still CONNECTING causes ws to emit
        // an asynchronous error. A replaced/explicitly closed socket is stale;
        // consume that expected error without forwarding it as a client error.
        if (this.ws !== socket) {
          log.debug({ camera: this.cameraName, error: err.message }, 'Stale WebSocket closed');
          reject(err);
          return;
        }

        log.error({ camera: this.cameraName, error: err.message }, 'WebSocket error');
        this.emit('error', err);
        if (this.state === 'connecting' || this.state === 'hello') {
          reject(err);
        }
      });

      const clearTimeoutFn = () => clearTimeout(timeout);
    });
  }

  /** Send the SDP answer back to the camera. */
  sendAnswer(sdp: RTCSessionDescriptionLike): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    if (!this.remoteId || !this.localId) {
      throw new Error('No remote/local ID set — SDP offer not yet received');
    }

    const msg = JSON.stringify({
      to: this.remoteId,
      from: this.localId,
      sdp,
    });
    log.debug({ camera: this.cameraName }, 'Sending SDP answer');
    this.ws.send(msg);
    this.state = 'streaming';
  }

  /** Relay a local ICE candidate to the remote peer. */
  sendIceCandidate(candidate: RTCIceCandidateLike): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.remoteId) return;

    this.ws.send(JSON.stringify({
      to: this.remoteId,
      ice: candidate,
    }));
  }

  /** Close the WebSocket connection. */
  close(): void {
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    this.state = 'disconnected';
    this.remoteId = null;
    this.localId = null;
  }

  private handleMessage(
    msg: string,
    cameraAuthToken: string,
    onSessionReady: () => void,
    clearTimeout: () => void,
  ): void {
    // Text protocol messages
    if (msg.startsWith('HELLO')) {
      log.debug({ camera: this.cameraName }, 'Received HELLO, sending START_SESSION');
      this.ws!.send(`START_SESSION ${cameraAuthToken}`);
      this.state = 'session';
      return;
    }

    if (msg.startsWith('SESSION_STARTED')) {
      log.info({ camera: this.cameraName }, 'Session started, waiting for SDP offer');
      clearTimeout();
      this.emit('sessionStarted');
      onSessionReady();
      return;
    }

    // JSON protocol messages (SDP offers, ICE candidates)
    let data: any;
    try {
      data = JSON.parse(msg);
    } catch {
      log.warn({ camera: this.cameraName, msg }, 'Unrecognized message');
      return;
    }

    if (data.sdp?.type === 'offer') {
      this.remoteId = data.from;
      this.localId = data.to;
      log.info({ camera: this.cameraName, from: this.remoteId }, 'Received SDP offer');
      this.emit('sdpOffer', data.sdp as RTCSessionDescriptionLike, data.from, data.to);
      return;
    }

    if (data.ice) {
      log.debug({ camera: this.cameraName }, 'Received ICE candidate');
      this.emit('iceCandidate', data.ice as RTCIceCandidateLike, data.from);
      return;
    }

    log.debug({ camera: this.cameraName, data }, 'Unhandled JSON message');
  }
}

export declare interface SignalingClient {
  on<E extends keyof SignalingClientEvents>(event: E, listener: SignalingClientEvents[E]): this;
  emit<E extends keyof SignalingClientEvents>(event: E, ...args: Parameters<SignalingClientEvents[E]>): boolean;
}
