export type { AlarmEvent, MotionEvent, MotionEndEvent, ClipEvent, SensorEvent } from './events/types.js';
export { EventType } from './events/types.js';

/** ICE server configuration for WebRTC peer connections. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** WebRTC config extracted from the endToEndWebrtcConnectionInfo response. */
export interface EndToEndWebrtcConfig {
  signallingServerUrl: string;
  signallingServerToken: string;
  cameraAuthToken: string;
  supportsAudio: boolean;
  supportsFullDuplex: boolean;
  iceServers: IceServer[];
}

/** Camera summary returned from the ADC cameras endpoint. */
export interface CameraSummary {
  id: string;
  description: string;
  deviceModel: string;
  privateIp: string;
  publicIp: string;
  supportsLiveView: boolean;
  macAddress: string;
}

/** Full video source API response shape. */
export interface VideoSourceResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      errorEnum: number;
      isMjpeg: boolean;
      urlEncoded: boolean;
      proxyStreamTimeoutTime: number;
      proxyUrl: string;
      janusGatewayUrl: string;
      janusToken: string;
      iceServers: string;
      spsAndPpsRequired: boolean;
    };
  };
  included: VideoSourceIncluded[];
}

export interface VideoSourceIncluded {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

/** Stream quality info from the API. */
export interface StreamQuality {
  streamID: number;
  resolution: string;
}

/** Events emitted by the signaling client. */
export interface SignalingEvents {
  sdpOffer: (offer: RTCSessionDescriptionLike, from: string, to: string) => void;
  iceCandidate: (candidate: RTCIceCandidateLike) => void;
  sessionStarted: () => void;
  error: (error: Error) => void;
  closed: () => void;
}

export interface RTCSessionDescriptionLike {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface RTCIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}
