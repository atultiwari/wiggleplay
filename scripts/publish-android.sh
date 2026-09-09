#!/usr/bin/env bash
# Publishes the self-contained Android APK to a rolling GitHub release so any phone or tablet can
# install it from one stable link (no cable, no developer mode):
#
#   https://github.com/atultiwari/wiggleplay/releases/download/android-latest/WigglePlay-Android.apk
#
# Usage:  scripts/publish-android.sh            # upload the APK that is already built
#         scripts/publish-android.sh --build    # build the release APK first
#
# Needs the GitHub CLI (`gh auth login` once). Re-running replaces the APK on the same release, so
# the link on the "For grown-ups" page of the website always points at the newest build.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=android-latest
ASSET=WigglePlay-Android.apk
APK=mobile/android/app/build/outputs/apk/release/app-release.apk

if [[ "${1:-}" == "--build" ]]; then
  mobile/scripts/build-android-apk.sh
fi
[[ -f "$APK" ]] || { echo "No release APK at $APK; run with --build first." >&2; exit 1; }

# The games-bundle stamp is read from the APK itself so the notes always match what was uploaded.
BUNDLE=$(unzip -p "$APK" assets/index.android.bundle | grep -a -o '[0-9]\{14\}-[0-9a-f]\{7\}' | head -1 || true)
[[ -n "$BUNDLE" ]] || BUNDLE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('mobile/assets/web-manifest.json','utf8')).version)")
APP_VERSION=$(node -e "console.log(require('./mobile/app.json').expo.version)")
SIZE=$(du -h "$APK" | cut -f1)
NOTES="WigglePlay for Android ${APP_VERSION} (games bundle ${BUNDLE}, ${SIZE}).

Install: open this page on the phone or tablet, download the APK, then allow the browser to
install it when Android asks. The games run fully offline; new games arrive through
Settings → Updates inside the app. This build is signed with a development key, so if a Play
Store version ever appears, uninstall this one first."

mkdir -p builds
cp "$APK" "builds/$ASSET"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --notes "$NOTES" --latest=false >/dev/null
else
  gh release create "$TAG" --title "WigglePlay for Android (latest)" --notes "$NOTES" --latest=false >/dev/null
fi
gh release upload "$TAG" "builds/$ASSET" --clobber
URL="$(gh repo view --json url -q .url)/releases/download/$TAG/$ASSET"
echo
echo "Published $ASSET ($SIZE, bundle $BUNDLE)"
echo "Download link: $URL"
command -v qrencode >/dev/null && qrencode -t ANSIUTF8 "$URL" || true
