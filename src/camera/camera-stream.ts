import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { SignalingClient } from '../signaling/signaling-client.js';
import { createChildLogger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import type { EndToEndWebrtcConfig, RTCSessionDescriptionLike, RTCIceCandidateLike } from '../types.js';

const log = createChildLogger('camera-stream');

const MAX_DIAL_IN_RETRIES = 12;
const DIAL_IN_RETRY_DELAY_MS = 10_000;
const INITIAL_WAKE_DELAY_MS = 5_000;

export type StreamState = 'idle' | 'connecting' | 'streaming' | 'error';

export type TokenFetcher = () => Promise<EndToEndWebrtcConfig | null>;

/**
 * Manages a single camera's WebRTC-to-RTSP pipeline:
 * ADC signaling → werift PeerConnection → RTP → ffmpeg → RTSP push to go2rtc
 */
export class CameraStream {
  private signaling: SignalingClient;
  private pc: RTCPeerConnection | null = null;
  private ffmpeg: ChildProcess | null = null;
  private videoSocket: Socket | null = null;
  private videoPort = 0;
  private _state: StreamState = 'idle';

  constructor(
    readonly cameraId: string,
    readonly cameraName: string,
    private readonly rtspBaseUrl: string,
  ) {
    this.signaling = new SignalingClient(cameraName);
  }

  get state(): StreamState {
    return this._state;
  }

  /**
   * Start the stream pipeline.
   *
   * Strategy (matches the HA integration's behavior):
   * 1. The initial token fetch (already done) wakes the camera on ADC's backend
   * 2. Try connecting — if camera hasn't dialed in, wait and fetch a FRESH token
   * 3. The fresh token creates a new signaling room that the now-awake camera can join
   */
  async start(config: EndToEndWebrtcConfig, refetchToken?: TokenFetcher): Promise<void> {
    let currentConfig = config;

    for (let attempt = 1; attempt <= MAX_DIAL_IN_RETRIES; attempt++) {
      try {
        await this.tryConnect(currentConfig);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isDialInError = message.includes('not yet dialed in');

        if (isDialInError && attempt < MAX_DIAL_IN_RETRIES) {
          // Wait longer on early attempts (camera may still be booting)
          const delay = attempt <= 2 ? 15_000 : DIAL_IN_RETRY_DELAY_MS;
          log.info(
            { camera: this.cameraName, attempt, maxAttempts: MAX_DIAL_IN_RETRIES },
            'Camera not yet dialed in, waiting %ds then fetching fresh token...',
            delay / 1000,
          );
          await this.stop();
          await sleep(delay);

          // Fetch a FRESH token — the camera should now be awake and will
          // dial in to this new signaling room
          if (refetchToken) {
            const fresh = await refetchToken();
            if (fresh) currentConfig = fresh;
          }
          continue;
        }

        this._state = 'error';
        throw err;
      }
    }
  }

  /** Tear down the entire pipeline. */
  async stop(): Promise<void> {
    this.signaling.removeAllListeners();
    this.signaling.close();

    if (this.pc) {
      await this.pc.close().catch(() => {});
      this.pc = null;
    }

    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }

    if (this.videoSocket) {
      this.videoSocket.close();
      this.videoSocket = null;
    }

    this._state = 'idle';
    log.info({ camera: this.cameraName }, 'Stream stopped');
  }

  private async tryConnect(config: EndToEndWebrtcConfig): Promise<void> {
    await this.stop();
    this._state = 'connecting';

    this.videoPort = await this.allocateUdpPort();
    log.info({ camera: this.cameraName, videoPort: this.videoPort }, 'Allocated RTP port');

    this.pc = new RTCPeerConnection({
      iceServers: config.iceServers.flatMap((s) =>
        s.urls.map((url) => ({
          urls: url,
          username: s.username,
          credential: s.credential,
        })),
      ),
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/H264',
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
        audio: [
          new RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            payloadType: 111,
          }),
          new RTCRtpCodecParameters({
            mimeType: 'audio/PCMU',
            clockRate: 8000,
            payloadType: 0,
          }),
          new RTCRtpCodecParameters({
            mimeType: 'audio/PCMA',
            clockRate: 8000,
            payloadType: 8,
          }),
        ],
      },
    });

    this.setupPeerConnection();

    // Connect signaling — resolve on SESSION_STARTED, reject on close/error
    await new Promise<void>((resolve, reject) => {
      this.signaling.on('sessionStarted', () => resolve());

      this.signaling.on('closed', (_code, reason) => {
        let errorMsg = reason;
        try {
          const parsed = JSON.parse(reason);
          if (parsed.error) errorMsg = parsed.error;
        } catch {}

        if (this._state === 'connecting') {
          reject(new Error(errorMsg));
        }
      });

      this.signaling.on('error', (err) => {
        if (this._state === 'connecting') reject(err);
      });

      this.signaling.connect(
        config.signallingServerUrl,
        config.signallingServerToken,
        config.cameraAuthToken,
      ).catch(reject);
    });

    log.info({ camera: this.cameraName }, 'Session started, waiting for SDP offer...');

    this.signaling.on('sdpOffer', async (offer) => {
      try {
        await this.handleSdpOffer(offer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ camera: this.cameraName }, 'SDP handling failed: %s', msg);
      }
    });

    this.signaling.on('iceCandidate', async (candidate) => {
      log.info({ camera: this.cameraName, candidate: candidate.candidate }, 'Remote ICE candidate');
      await this.handleRemoteIceCandidate(candidate);
    });

    this.signaling.on('closed', (_code, reason) => {
      if (this._state === 'streaming') {
        log.warn({ camera: this.cameraName, reason }, 'Signaling closed while streaming');
      }
    });
  }

  private setupPeerConnection(): void {
    const pc = this.pc!;
    let rtpSubscribed = false;
    let rtpCount = 0;

    const subscribeToRtp = (track: any, source: string) => {
      if (rtpSubscribed) return;
      rtpSubscribed = true;

      // Start ffmpeg and create the send socket
      this.startFfmpeg();
      this.videoSocket = createSocket('udp4');

      track.onReceiveRtp.subscribe((rtp: any) => {
        if (this.videoSocket && this.videoPort) {
          const buf = rtp.serialize();
          this.videoSocket.send(buf, this.videoPort, '127.0.0.1');
          rtpCount++;
          if (rtpCount === 1 || rtpCount === 100) {
            log.info({ camera: this.cameraName, rtpCount, bytes: buf.length }, 'RTP packets sent to ffmpeg');
          } else if (rtpCount % 1000 === 0) {
            log.debug({ camera: this.cameraName, rtpCount, bytes: buf.length }, 'RTP packets sent to ffmpeg');
          }
        }
      });

      this._state = 'streaming';
      log.info({ camera: this.cameraName, source }, 'Video streaming active');
    };

    // Method 1: onRemoteTransceiverAdded — earliest possible, receiver may not exist yet
    pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
      log.info(
        { camera: this.cameraName, mid: transceiver.mid, kind: transceiver.kind, direction: transceiver.direction,
          hasReceiver: !!transceiver.receiver, hasTrack: !!transceiver.receiver?.track },
        'Remote transceiver added',
      );
      if (transceiver.kind === 'video' && transceiver.receiver?.track) {
        subscribeToRtp(transceiver.receiver.track, 'onRemoteTransceiverAdded');
      }
    });

    // Method 2: onTrack — standard event
    pc.onTrack.subscribe((track) => {
      log.info({ camera: this.cameraName, kind: track.kind }, 'onTrack fired');
      if (track.kind === 'video') {
        subscribeToRtp(track, 'onTrack');
      }
    });

    // Method 3: ontrack callback — alternative style
    pc.ontrack = (ev) => {
      log.info({ camera: this.cameraName, kind: ev.track.kind }, 'ontrack callback fired');
      if (ev.track.kind === 'video') {
        subscribeToRtp(ev.track, 'ontrack callback');
      }
    };

    // Method 4: When connected, scan transceivers as last resort
    pc.connectionStateChange.subscribe((state) => {
      if (state !== 'connected') return;
      log.info({ camera: this.cameraName }, 'Connection connected, scanning transceivers');
      for (const t of pc.getTransceivers()) {
        log.info(
          { camera: this.cameraName, mid: t.mid, kind: t.kind, hasReceiver: !!t.receiver, hasTrack: !!t.receiver?.track },
          'Transceiver state on connected',
        );
        if (t.kind === 'video' && t.receiver?.track) {
          subscribeToRtp(t.receiver.track, 'connectionStateChange scan');
        }
      }
    });

    pc.onIceCandidate.subscribe((candidate) => {
      log.info({ camera: this.cameraName, candidate: candidate.candidate }, 'Local ICE candidate');
      this.signaling.sendIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    });

    pc.iceConnectionStateChange.subscribe((state) => {
      log.info({ camera: this.cameraName, iceState: state }, 'ICE connection state changed');
    });

    pc.iceGatheringStateChange.subscribe((state) => {
      log.info({ camera: this.cameraName, iceGathering: state }, 'ICE gathering state changed');
    });

    pc.connectionStateChange.subscribe((state) => {
      log.info({ camera: this.cameraName, connectionState: state }, 'Connection state changed');
      if (state === 'failed' || state === 'disconnected') {
        this._state = 'error';
      }
    });
  }

  private async handleSdpOffer(offer: RTCSessionDescriptionLike): Promise<void> {
    const pc = this.pc!;
    log.info({ camera: this.cameraName }, 'SDP offer received, setting remote description');

    // Log the SDP so we can debug codec/track issues
    const mediaLines = offer.sdp.split('\n').filter((l: string) => l.startsWith('m=') || l.startsWith('a=rtpmap'));
    log.info({ camera: this.cameraName, mediaLines }, 'SDP offer media lines');

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });

    const transceivers = pc.getTransceivers();
    for (const t of transceivers) {
      log.info(
        { camera: this.cameraName, mid: t.mid, kind: t.kind, direction: t.direction },
        'Transceiver after setRemoteDescription',
      );
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Log answer media lines too
    const answerMediaLines = answer.sdp.split('\n').filter((l: string) => l.startsWith('m=') || l.startsWith('a=rtpmap'));
    log.info({ camera: this.cameraName, answerMediaLines }, 'SDP answer media lines');

    this.signaling.sendAnswer({
      type: 'answer',
      sdp: answer.sdp,
    });
    log.info({ camera: this.cameraName }, 'SDP answer sent');
  }

  private async handleRemoteIceCandidate(candidate: RTCIceCandidateLike): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      } as any);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ camera: this.cameraName }, 'Failed to add ICE candidate: %s', msg);
    }
  }

  private startFfmpeg(): void {
    if (this.ffmpeg) return;

    const rtspUrl = `${this.rtspBaseUrl}/${this.cameraName}`;

    // ffmpeg needs an SDP descriptor to know the codec format of the RTP stream
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=ADC Camera',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=video ${this.videoPort} RTP/AVP 96`,
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 packetization-mode=1',
    ].join('\r\n') + '\r\n';

    const args = [
      '-hide_banner',
      '-loglevel', 'info',
      // Give ffmpeg enough time to receive an IDR frame with SPS/PPS
      '-analyzeduration', '10000000',
      '-probesize', '32000000',
      '-fflags', '+genpts+discardcorrupt',
      '-reorder_queue_size', '0',
      // Read SDP from stdin to know what format the RTP is
      '-protocol_whitelist', 'file,udp,rtp,pipe',
      '-f', 'sdp',
      '-i', 'pipe:0',
      // Output: passthrough to RTSP
      '-c:v', 'copy',
      '-bsf:v', 'dump_extra',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      rtspUrl,
    ];

    log.info({ camera: this.cameraName, rtspUrl }, 'Starting ffmpeg');
    this.ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // Write the SDP to ffmpeg's stdin, then close it
    this.ffmpeg.stdin?.write(sdp);
    this.ffmpeg.stdin?.end();

    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      // ffmpeg progress lines are noisy once streaming is established
      const isProgress = line.startsWith('frame=') || line.startsWith('size=');
      if (isProgress) {
        log.debug({ camera: this.cameraName, ffmpeg: line }, 'ffmpeg');
      } else {
        log.info({ camera: this.cameraName, ffmpeg: line }, 'ffmpeg');
      }
    });

    this.ffmpeg.on('exit', (code) => {
      log.warn({ camera: this.cameraName, code }, 'ffmpeg exited');
      this.ffmpeg = null;
    });
  }

  /** Allocate a random available UDP port by briefly binding then releasing. */
  private allocateUdpPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = createSocket('udp4');
      sock.bind(0, '127.0.0.1', () => {
        const port = sock.address().port;
        sock.close(() => resolve(port));
      });
      sock.on('error', reject);
    });
  }
}
