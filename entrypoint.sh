#!/bin/sh
set -e

: "${GO2RTC_API_USERNAME:?GO2RTC_API_USERNAME is required}"
: "${GO2RTC_API_PASSWORD:?GO2RTC_API_PASSWORD is required}"
: "${GO2RTC_RTSP_USERNAME:?GO2RTC_RTSP_USERNAME is required}"
: "${GO2RTC_RTSP_PASSWORD:?GO2RTC_RTSP_PASSWORD is required}"

if [ ! -r /app/config/go2rtc.yaml ]; then
  echo "Missing readable /app/config/go2rtc.yaml" >&2
  exit 1
fi

# Start go2rtc in background with config from mounted volume
go2rtc -config /app/config/go2rtc.yaml &
GO2RTC_PID=$!

# Wait for go2rtc API to be ready
echo "Waiting for go2rtc..."
attempt=0
until curl --fail --silent --show-error --max-time 2 http://localhost:1984/api/streams > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "go2rtc did not become ready within 60 seconds" >&2
    kill "$GO2RTC_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "go2rtc ready"

# Start the bridge
exec node dist/index.js
