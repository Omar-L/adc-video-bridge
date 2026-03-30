# adc-video-bridge

Bridges Alarm.com security camera streams to local RTSP for HomeKit Secure Video (HKSV) via Homebridge.

## Problem

Alarm.com cameras cannot be accessed directly via RTSP — ADC re-provisions camera credentials via OpenVPN and randomly generates root passwords. The existing [homebridge-node-alarm-dot-com](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com) plugin handles alarm panel/sensors/locks but has no video support.

## Solution

This bridge authenticates with Alarm.com's web API, negotiates a WebRTC connection to the camera via ADC's end-to-end signaling protocol, receives the H.264 video stream server-side using [werift](https://github.com/nicknisi/werift-webrtc), and republishes it as a local RTSP stream via ffmpeg → [go2rtc](https://github.com/AlexxIT/go2rtc).

The approach was proven by [kjjohnsen/HomeAssistantADCCameraIntegration](https://github.com/kjjohnsen/HomeAssistantADCCameraIntegration), which does the same thing in the browser. This project ports the signaling protocol to Node.js for headless server-side operation.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                 adc-video-bridge (Node.js)                │
│                                                           │
│  [AlarmAuth] ──→ [TokenManager]                           │
│       │               │                                   │
│       │        [CameraManager]                            │
│       │          │          │                              │
│       │   [CameraStream] × N                              │
│       │     │           │                                  │
│       │  [ADC Signaling WS]    [werift PC]                │
│       │   HELLO/SDP/ICE      WebRTC termination           │
│       │                          │                        │
│       │                    RTP packets                     │
│       │                          │                        │
│       │                   [ffmpeg pipe]                    │
│       │                    RTSP publish ──────────────┐    │
│       │                                              │    │
│  [AlarmEventListener]                                │    │
│   ADC WebSocket event stream                         │    │
│   motion / sensor / clip events                      │    │
│       │                                              │    │
└───────┼──────────────────────────────────────────────┼────┘
        │ motion webhook                    RTSP push  │
        │                                ┌─────▼─────┐
        │                                │  go2rtc    │ (same container)
        │                                │  RTSP in   │
        │                                │  RTSP out  │
        │                                └─────┬─────┘
        │                                      │ rtsp://localhost:8554/<cam>
        │                            ┌─────────▼──────────┐
        └───────────────────────────→│ homebridge-camera-  │
                                     │ ffmpeg (HKSV)       │
                                     └────────────────────┘
```

## How the signaling works

The ADC end-to-end WebRTC signaling protocol (ported from the HA integration's `alarm-webrtc-card.js`):

1. Fetch video token: `GET /web/api/video/videoSources/liveVideoHighestResSources/<cameraId>`
2. Extract `endToEndWebrtcConnectionInfo` from response (signalling URL, JWT token, camera auth token, ICE servers)
3. Connect WebSocket to `${signallingServerUrl}/${signallingServerToken}`
4. Send `HELLO 2.0.1` → receive `HELLO`
5. Send `START_SESSION <cameraAuthToken>` → receive `SESSION_STARTED`
6. Receive SDP offer (JSON) → create answer with werift → send answer back
7. Exchange ICE candidates
8. WebRTC media flows (H.264 1080p @ 10fps)

### Key discovery: camera wake timing

The `liveVideoHighestResSources` API call triggers the camera to wake up and dial in to the signaling server. The camera takes a few seconds to connect, so:
- First attempt usually fails with "Camera has not yet dialed in"
- Retry with a fresh token after 15 seconds — the camera is now awake
- Subsequent retries use 10-second intervals

The bridge refreshes video tokens every 10 minutes, tearing down and re-establishing the WebRTC connection each time. ADC telemetry confirms there is no server-enforced session timeout — the refresh interval is set conservatively to keep signaling credentials fresh. Each rebuild causes a ~1-2 second gap in the RTSP stream.

## Current status

**Working:**
- Alarm.com authentication via `node-alarm-dot-com`
- Camera discovery CLI (`npx tsx src/discover.ts`)
- Video token fetching and refresh (10-minute cycle)
- End-to-end WebRTC signaling (HELLO/START_SESSION/SDP/ICE)
- WebRTC connection establishment with STUN/TURN
- H.264 RTP packet extraction from werift
- H.264 fmtp passthrough (profile-level-id, sprop-parameter-sets from camera SDP offer)
- ffmpeg RTSP output to go2rtc
- Docker container with go2rtc sidecar
- Multi-camera streaming (3 cameras verified, 1920x1080 H.264 @ 10fps)
- Camera dial-in retry with exponential backoff (up to 12 attempts)
- Real-time motion detection via ADC WebSocket event stream
- WebSocket event listener with proactive token refresh and exponential backoff on errors
- Motion webhook forwarding to homebridge-camera-ffmpeg
- HomeKit live view and motion notifications via Homebridge
- HomeKit Secure Video (HKSV) recording triggered by motion events

**Not yet done:**
- go2rtc stream auto-configuration (currently manual in `config/go2rtc.yaml`)
- Audio passthrough
- Seamless stream handoff (overlap old/new streams during token refresh to eliminate gap)

## Project structure

```
src/
├── index.ts                  # Entry point, graceful shutdown
├── config.ts                 # YAML config loader
├── types.ts                  # Shared interfaces
├── discover.ts               # Camera discovery CLI
├── auth/
│   ├── alarm-auth.ts         # Wraps node-alarm-dot-com login + camera discovery
│   └── token-manager.ts      # Session refresh (55min) + video token refresh (10min/camera)
├── signaling/
│   └── signaling-client.ts   # WebSocket: HELLO, START_SESSION, SDP/ICE relay
├── camera/
│   ├── camera-stream.ts      # Per-camera: signaling → werift → RTP → ffmpeg → RTSP
│   └── camera-manager.ts     # Multi-camera orchestration with backoff
├── events/
│   ├── alarm-event-listener.ts  # ADC WebSocket event stream with proactive refresh
│   ├── parse-event.ts        # Event parsing (motion, sensor, clip events)
│   └── types.ts              # Event type definitions
├── go2rtc/
│   └── go2rtc-api.ts         # go2rtc REST API health checks
└── utils/
    ├── logger.ts             # pino structured logging
    ├── retry.ts              # Exponential backoff helper
    └── sdp.ts                # H.264 fmtp extraction from SDP offers
```

## Setup

See the **[Setup Guide](docs/SETUP.md)** for full end-to-end instructions covering Docker deployment, camera discovery, configuration, Homebridge integration, and HomeKit motion notifications.

**Quick start:**

```bash
git clone https://github.com/Omar-L/adc-video-bridge.git
cd adc-video-bridge
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
# Edit both config files with your credentials and camera IDs
docker compose -f docker-compose.yml up --build -d
```

## Environment variables

Credentials can be provided via config file or environment variables. Env vars are recommended for Docker deployments.

| Variable | Description | Required |
|----------|-------------|----------|
| `ADC_USERNAME` | Alarm.com account email | Yes |
| `ADC_PASSWORD` | Alarm.com account password | Yes |
| `ADC_MFA_TOKEN` | Two-factor authentication token (from trusted device setup) | No |

Config file values take precedence over env vars. See `config/config.example.yaml` for the full configuration reference.

## Dependencies

- [node-alarm-dot-com](https://github.com/node-alarm-dot-com/node-alarm-dot-com) — Alarm.com authentication
- [werift](https://github.com/nicknisi/werift-webrtc) — Pure TypeScript WebRTC (server-side PeerConnection)
- [ws](https://github.com/websockets/ws) — WebSocket client for ADC signaling
- [go2rtc](https://github.com/AlexxIT/go2rtc) — RTSP server (accepts ffmpeg push, serves to clients)
- [pino](https://github.com/pinojs/pino) — Structured logging
- ffmpeg — RTP → RTSP transcoding (copy mode, no re-encoding)

## Limitations

### Not a 24/7 stream

ADC cameras are designed for on-demand live view, not continuous streaming. The bridge holds a perpetual live view session by refreshing tokens every 10 minutes, but this is a workaround — ADC does not officially support persistent streaming. ADC telemetry confirms there is no server-enforced WebRTC session timeout, so the 10-minute interval is conservative.

### API rate limits

Alarm.com may ban accounts that poll too aggressively. Known safe minimums (from [homebridge-node-alarm-dot-com](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com)):

- **Session re-authentication**: ≥10 minutes (bridge uses 55 min)
- **Device polling**: ≥60 seconds (bridge uses 10 min per camera)

With multiple cameras, aggregate API load scales linearly — 3 cameras means a video token API call roughly every 200 seconds.

## Future exploration

### Native HKSV via go2rtc ([#11](https://github.com/Omar-L/adc-video-bridge/issues/11))

go2rtc PR [AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) adds native HomeKit Secure Video support with a standalone `pkg/hksv/` library. This would eliminate the entire Homebridge stack — go2rtc would expose cameras directly to Apple Home with H.264 passthrough (no re-encoding), lower latency, and motion events via a simple HTTP API. See issue [#11](https://github.com/Omar-L/adc-video-bridge/issues/11) for the full analysis and phased rollout plan.
