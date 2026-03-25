#!/bin/sh
# Copy node-alarm-dot-com into vendor/ for Docker builds
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

rm -rf "$PROJECT_DIR/vendor/node-alarm-dot-com"
mkdir -p "$PROJECT_DIR/vendor/node-alarm-dot-com"

# Build the dependency
cd "$PROJECT_DIR/../node-alarm-dot-com"
npm run build

# Copy built dist + package.json
cp -r dist package.json "$PROJECT_DIR/vendor/node-alarm-dot-com/"

echo "Vendored node-alarm-dot-com into vendor/"
