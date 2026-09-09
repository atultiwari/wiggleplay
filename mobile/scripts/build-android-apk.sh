#!/usr/bin/env bash
# Builds the installable, self-contained Android APK (release variant, signed with the debug
# keystore so it installs on any phone). The *debug* APK needs a Metro dev server: never ship it.
set -e
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
npm run sync-web
[ -d android ] || LANG=en_US.UTF-8 npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease --no-daemon
echo "APK: $(pwd)/app/build/outputs/apk/release/app-release.apk"
