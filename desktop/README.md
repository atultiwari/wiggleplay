# WigglePlay for Windows and macOS

An Electron shell around the WigglePlay web app that runs fully offline once installed.

```bash
npm install
npm start          # builds ../ with a root base path into web/, compiles src/, opens the window
npm test           # runtime-asset verification and download logic (node:test)
npm run smoke      # Playwright drives the app with a fake camera and checks nothing leaves the machine
npm run dist:mac   # release/*.dmg and *.zip (arm64 + x64)
npm run dist:win   # release/WigglePlay Setup *.exe (NSIS) and a portable exe
```

How it works:

- `src/main.ts` registers the `wiggleplay://` scheme and serves `web/` from it. That origin is a
  secure context, so `getUserMedia`, WASM and `fetch` all work without a server or the internet.
  Every outbound http(s) request is cancelled (fonts are self-hosted; MediaPipe's telemetry ping
  is dropped).
- `src/assets.ts` lists the runtime files the trackers need (MediaPipe WASM + the hand and pose
  models) and verifies them on every start. They are bundled by default; a
  `npm run build:web:lite` build omits them (installer ~50 MB smaller) and the setup screen in
  `setup/index.html` downloads them once into the user's app-data folder with progress and retry.
- macOS asks for camera and microphone access through the system dialog; the usage strings live
  in `package.json` → `build.mac.extendInfo`.
- Environment knobs for testing: `WIGGLEPLAY_FAKE_CAMERA=1` (Chromium's fake camera),
  `WIGGLEPLAY_ASSET_DIR` (download folder), `WIGGLEPLAY_ASSET_ORIGIN` (download source).
- Builds are unsigned. On macOS, right-click → Open the first time; on Windows, SmartScreen will
  warn until the installer is signed.
