# adc-video-bridge

Bridges Alarm.com security camera streams to local RTSP for HomeKit Secure Video (HKSV) via Homebridge.

## Problem

Alarm.com cameras cannot be accessed directly via RTSP — ADC re-provisions camera credentials via OpenVPN and randomly generates root passwords. The existing [homebridge-node-alarm-dot-com](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com) plugin handles alarm panel/sensors/locks but has no video support.

## Solution

This bridge authenticates with Alarm.com's web API, negotiates a WebRTC connection to the camera via ADC's end-to-end signaling protocol, receives the H.264 video stream server-side using [werift](https://github.com/nicknisi/werift-webrtc), and republishes it as a local RTSP stream via ffmpeg → [go2rtc](https://github.com/AlexxIT/go2rtc).

The approach was proven by [kjjohnsen/HomeAssistantADCCameraIntegration](https://github.com/kjjohnsen/HomeAssistantADCCameraIntegration), which does the same thing in the browser. This project ports the signaling protocol to Node.js for headless server-side operation.

## Architecture

```
┌──────────────────────────────────────────────┐
│           adc-video-bridge (Node.js)         │
│                                              │
│  [AlarmAuth] → [TokenManager]                │
│                     │                        │
│              [CameraStream] × N              │
│                │           │                 │
│  [ADC Signaling WS]    [werift PC]           │
│   HELLO/SDP/ICE      WebRTC termination      │
│                          │                   │
│                    RTP packets                │
│                          │                   │
│                   [ffmpeg pipe]               │
│                    RTSP publish               │
└──────────────────┬───────────────────────────┘
                   │ RTSP push
             ┌─────▼─────┐
             │  go2rtc    │  (same container)
             │  RTSP in   │
             │  RTSP out  │
             └─────┬─────┘
                   │ rtsp://localhost:8554/<cam-name>
         ┌─────────▼──────────┐
         │ homebridge-camera-  │
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

Token TTL is 180 seconds. The bridge refreshes tokens every 150 seconds, tearing down and re-establishing the WebRTC connection each time. This causes a ~1-2 second gap in the RTSP stream, which HKSV handles gracefully.

## Current status

**Working:**
- Alarm.com authentication via `node-alarm-dot-com`
- Camera discovery (`GET /web/api/video/devices/cameras`)
- Video token fetching and refresh (150s cycle)
- End-to-end WebRTC signaling (HELLO/START_SESSION/SDP/ICE)
- WebRTC connection establishment with STUN/TURN
- H.264 RTP packet extraction from werift
- ffmpeg RTSP output to go2rtc
- Docker container with go2rtc sidecar
- Verified streaming 1920x1080 H.264 @ 10fps, viewable in VLC

**Not yet done:**
- Multi-camera testing (single camera verified)
- Homebridge camera-ffmpeg integration
- Deployment to production server
- go2rtc stream auto-configuration (currently manual in `config/go2rtc.yaml`)
- Cleanup of debug logging verbosity

## Project structure

```
src/
├── index.ts                  # Entry point, graceful shutdown
├── config.ts                 # YAML config loader
├── types.ts                  # Shared interfaces
├── auth/
│   ├── alarm-auth.ts         # Wraps node-alarm-dot-com login + camera discovery
│   └── token-manager.ts      # Session refresh (55min) + video token refresh (150s/camera)
├── signaling/
│   └── signaling-client.ts   # WebSocket: HELLO, START_SESSION, SDP/ICE relay
├── camera/
│   ├── camera-stream.ts      # Per-camera: signaling → werift → RTP → ffmpeg → RTSP
│   └── camera-manager.ts     # Multi-camera orchestration
├── go2rtc/
│   └── go2rtc-api.ts         # go2rtc REST API health checks
└── utils/
    ├── logger.ts             # pino structured logging
    └── retry.ts              # Exponential backoff helper
```

## Setup

### Prerequisites

- Node.js 20+
- Docker (for containerized deployment)
- An Alarm.com account with cameras

### Local development

```bash
# Install deps (requires node-alarm-dot-com built locally at ../node-alarm-dot-com)
npm install

# Create config
cp config.example.yaml config/config.yaml
# Edit config/config.yaml with your credentials and camera IDs

# Run locally (requires go2rtc running separately)
npx tsx src/index.ts
```

### Docker

```bash
# Node.js and npm are required on the host to build the vendored dependency
# Ubuntu/Debian: sudo apt install nodejs npm

# Vendor the node-alarm-dot-com dependency
./scripts/prepare-docker.sh

# Build and run (detached)
docker compose -f docker-compose.yml up --build -d

# View logs
docker compose -f docker-compose.yml logs -f

# View go2rtc web UI (use your server's IP)
# http://<server-ip>:1984

# View stream in VLC (use your server's IP)
# rtsp://<server-ip>:8554/<camera-name>
```

### Rebuild and redeploy

After pulling new changes or modifying config:

```bash
# Re-vendor dependency (only needed if node-alarm-dot-com changed)
./scripts/prepare-docker.sh

# Rebuild and restart
docker compose -f docker-compose.yml up --build -d

# Verify it's running
docker compose -f docker-compose.yml logs -f
```

### go2rtc configuration

Camera streams are auto-registered by the bridge via the go2rtc REST API. No manual stream entries are needed in `config/go2rtc.yaml`:

```yaml
rtsp:
  listen: ":8554"

api:
  listen: ":1984"
```

## Dependencies

- [node-alarm-dot-com](https://github.com/node-alarm-dot-com/node-alarm-dot-com) — Alarm.com authentication
- [werift](https://github.com/nicknisi/werift-webrtc) — Pure TypeScript WebRTC (server-side PeerConnection)
- [ws](https://github.com/websockets/ws) — WebSocket client for ADC signaling
- [go2rtc](https://github.com/AlexxIT/go2rtc) — RTSP server (accepts ffmpeg push, serves to clients)
- [pino](https://github.com/pinojs/pino) — Structured logging
- ffmpeg — RTP → RTSP transcoding (copy mode, no re-encoding)

## Future exploration

go2rtc has a native [HomeKit output](https://github.com/AlexxIT/go2rtc#homekit) (`homekit` server). This could potentially let go2rtc expose cameras directly to Apple Home without needing homebridge-camera-ffmpeg at all. That's something to explore once the basic stream pipeline is stable and multi-camera support is tested.
