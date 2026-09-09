#!/usr/bin/env bash
# Launches the installed app on a booted iOS simulator, waits, and saves screenshots of the
# unpacking screen and the hub for a quick offline sanity check. Usage: scripts/simulator-check.sh [device]
set -e
DEVICE=${1:-"iPhone 17 Pro"}
OUT=${OUT:-/tmp/wiggleplay-sim}
mkdir -p "$OUT"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl terminate "$DEVICE" in.atultiwari.wiggleplay 2>/dev/null || true
xcrun simctl launch "$DEVICE" in.atultiwari.wiggleplay
sleep 4
xcrun simctl io "$DEVICE" screenshot "$OUT/1-unpacking.png"
sleep 25
xcrun simctl io "$DEVICE" screenshot "$OUT/2-hub.png"
echo "screenshots in $OUT"
