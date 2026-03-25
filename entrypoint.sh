#!/bin/sh
set -e

# Start go2rtc in background with config from mounted volume
go2rtc -config /app/config/go2rtc.yaml &
GO2RTC_PID=$!

# Wait for go2rtc API to be ready
echo "Waiting for go2rtc..."
until curl -sf http://localhost:1984/api/streams > /dev/null 2>&1; do
  sleep 1
done
echo "go2rtc ready"

# Start the bridge
exec node dist/index.js
