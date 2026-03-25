#!/bin/sh
# Clone, build, and vendor node-alarm-dot-com for Docker builds
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="$PROJECT_DIR/vendor/node-alarm-dot-com"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Cloning node-alarm-dot-com into temp directory..."
git clone --depth 1 https://github.com/node-alarm-dot-com/node-alarm-dot-com.git "$TEMP_DIR/node-alarm-dot-com"

echo "Building..."
cd "$TEMP_DIR/node-alarm-dot-com"
npm install
npm run build

echo "Vendoring into $VENDOR_DIR..."
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
cp -r dist package.json "$VENDOR_DIR/"

echo "Done — vendored node-alarm-dot-com into vendor/"
