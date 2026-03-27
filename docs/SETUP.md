# Setup Guide

End-to-end walkthrough for deploying adc-video-bridge on a server and connecting it to Homebridge for live streaming and motion notifications in Apple HomeKit.

## Prerequisites

- A server or machine that can run Docker (Linux, macOS, etc.)
- An Alarm.com account with cameras that support end-to-end WebRTC streaming (e.g. ADC-V723)
- [Homebridge](https://homebridge.io) with the [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) plugin installed

## Step 1: Discover your cameras

Clone the repo and run the discovery tool to find your camera IDs:

```bash
git clone https://github.com/Omar-L/adc-video-bridge.git
cd adc-video-bridge
npm install

# Set credentials temporarily for discovery
export ADC_USERNAME="your@email.com"
export ADC_PASSWORD="yourpassword"

npx tsx src/discover.ts
```

This prints a table of cameras on your account and outputs ready-to-paste YAML for the config files. Note the camera IDs and names.

## Step 2: Configure the bridge

Copy the example configs:

```bash
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
```

### `config/config.yaml`

Your ADC credentials, cameras, and optional Homebridge motion integration:

```yaml
alarm:
  username: "your@email.com"
  password: "yourpassword"
  mfaToken: ""  # optional, for 2FA bypass

cameras:
  - id: "100652375-2048"
    name: "driveway"              # go2rtc stream name (lowercase, no spaces)
    homebridgeName: "Driveway"    # must match the camera name in homebridge-camera-ffmpeg
    quality: "hd"
  - id: "100652375-2050"
    name: "backyard"
    homebridgeName: "Backyard"
    quality: "hd"

go2rtc:
  apiUrl: "http://localhost:1984"
  rtspPort: 8554

# Optional: forward motion events to homebridge-camera-ffmpeg
homebridge:
  motionUrl: "http://<homebridge-ip>:8080"
  motionTimeoutMs: 60000  # reset motion after 60s of no activity

logging:
  level: "info"
```

- `name` is the go2rtc stream identifier — keep it lowercase with no spaces.
- `homebridgeName` must exactly match the camera name you set in homebridge-camera-ffmpeg.
- `homebridge.motionUrl` is the base URL of the homebridge-camera-ffmpeg HTTP server. Leave the entire `homebridge` section out to disable motion webhooks.

### `config/go2rtc.yaml`

Each camera needs a matching empty stream entry. The stream names must match the `name` field in `config.yaml`:

```yaml
streams:
  driveway: ""
  backyard: ""

rtsp:
  listen: ":8554"

api:
  listen: ":1984"

log:
  level: info
```

## Step 3: Deploy with Docker

```bash
docker compose -f docker-compose.yml up --build -d
```

Verify the streams are running:

```bash
# Check logs
docker compose -f docker-compose.yml logs -f

# Open go2rtc web UI to see active streams
# http://<server-ip>:1984

# Test a stream in VLC
# rtsp://<server-ip>:8554/driveway
```

All three cameras should show `"streaming"` in the periodic status log.

## Step 4: Configure homebridge-camera-ffmpeg

In the Homebridge UI, add a camera to the Camera-ffmpeg platform for each stream. Replace `<server-ip>` with the IP of the machine running adc-video-bridge.

### Per-camera settings

| Setting | Value |
|---------|-------|
| **Name** | `Driveway` (must match `homebridgeName` in config.yaml) |
| **Video Source** | `-i rtsp://<server-ip>:8554/driveway` |
| **Still Image Source** | `-timeout 10000000 -i http://<server-ip>:1984/api/frame.jpeg?src=driveway -vframes 1` |
| **Audio** | disabled |
| **Motion sensor** | enabled |
| **Motion Timeout** | `0` (the bridge controls the reset via `motionTimeoutMs`) |

The `-timeout 10000000` (10 seconds) on the still image source prevents ffmpeg from hanging indefinitely when go2rtc has no frame available during token refresh gaps. Without it, Homebridge can become unresponsive.

### Platform-level settings

| Setting | Value |
|---------|-------|
| **HTTP Port** | `8080` (must match `motionUrl` port in config.yaml) |

Restart Homebridge after making changes.

## Step 5: Enable motion notifications in HomeKit

For each camera in the Apple Home app:

1. Long press the camera tile
2. Tap the gear icon (settings)
3. Enable **Notifications** for motion events

Motion is detected via Alarm.com's real-time WebSocket event stream and forwarded to Homebridge automatically. When a camera detects motion, the bridge sends a trigger to homebridge-camera-ffmpeg's HTTP server, which activates the HomeKit motion sensor. After the configured timeout (default 60 seconds), the motion sensor resets.

## Rebuild and redeploy

After pulling new changes or modifying config:

```bash
docker compose -f docker-compose.yml up --build -d
docker compose -f docker-compose.yml logs -f
```

Config file changes (in `config/`) don't require a rebuild — just restart:

```bash
docker compose -f docker-compose.yml restart
```

## Troubleshooting

- **Streams not starting**: Check logs for authentication errors. Verify credentials in `config.yaml`.
- **Snapshots timing out in Homebridge**: Ensure the still image source includes `-timeout 10000000` before `-i`.
- **Motion not triggering in HomeKit**: Verify `homebridgeName` matches the camera name in homebridge-camera-ffmpeg exactly (case-sensitive). Check that the motion sensor is enabled in the plugin config and notifications are enabled in the Home app.
- **"Camera not found" in motion webhook logs**: The `homebridgeName` doesn't match. The bridge calls `GET http://<motionUrl>/motion?<homebridgeName>` — the name must be an exact match.
- **go2rtc web UI not loading**: Ensure port 1984 is exposed in docker-compose.yml and not blocked by a firewall.

## Local development

For developing without Docker:

```bash
npm install
cp config/config.example.yaml config/config.yaml
# Edit config.yaml with your credentials

# Requires go2rtc running separately
npm run dev
```
