# WigglePlay — Move, Play, Learn

> Keyboard-free, camera-powered learning games for toddlers (2½ years and up).
> If screen time can't always be avoided, it can at least be active, playful and educational.
>
> Created by **[Atul Tiwari](https://github.com/atultiwari)**, a parent, for his own toddler — and built in a
> kid-friendly manner from the ground up: no keyboard, no mouse, no wrong answers, nothing to lose.

**Live site:** https://atultiwari.github.io/wiggleplay/

WigglePlay is a one-stop web app where parents pick games by **how they are played**
(camera & body, touch, voice, tilt & shake), by **age band** and by **interest**
(colours, counting, fruits, movement…). The first four games use the webcam and
on-device hand tracking, so a small child can play by simply waving at the screen.

## Games

| Game | How to play | What it teaches |
|------|-------------|-----------------|
| 🖌️ **Air Painting** | Point a finger at the camera to paint. Hover over a colour to pick it, make a fist to stop. | Colour names, fine motor, creativity |
| ⭐ **Catch the Stars** | Move a hand left/right; the mascot's basket follows. Stars are counted aloud to ten. | Counting to 10, tracking, gross motor |
| 🫧 **Wave to Pop** | Bubbles float over the camera picture. Touch them to pop and hear their colour. | Cause and effect, colours |
| 🍉 **Fruit Slice** | Swish through flying fruit to slice it. Every fruit is named. No bombs. | Fruit names, hand-eye coordination |
| 🐱 **Tickle the Cat** | Cats pop up all over the screen. Touch one and it meows, bounces and says its colour. | Animal sounds, colours, cause and effect |
| ✈️ **Fly High** | Move up and down to fly the aeroplane through clouds and into balloons, counted aloud to ten. | Up/down, counting, colours |
| 🚌 **Bus Driver** | Drive the bus left and right to pick up cats, a puppy and a bunny waiting at the stop. | Left/right, counting, animal names |
| 🚍 **Beep Meow Whoosh** | Planes, buses and cats cross the screen. Touch them to hear their sounds and names, then find the one we ask for. | First words, listening, sounds |
| 🪞 **Wiggle Mirror** | A 3D WigglePlay monster copies the child's body live: wave, lean, step, lift both hands for a hooray. | Body awareness, imitation, gross motor |
| 🏘️ **3D Toy Town** | A little 3D town in the child's room: the bus drives, the aeroplane flies, the cat watches. Touch a toy with any body part to make it beep, whoosh or meow, and find the one the voice asks for. | First words, listening, reaching |
| 🪞 **Simon Says Mirror** | "Simon says: touch your nose!" The camera watches the child do hands up, touch nose / head / tummy, clap, wave and (optionally) jump or stand on one foot, and cheers each one. | Body parts, listening, gross motor |
| 🐄 **Tap the Farm** *(touch)* | Tap the cow, pig, sheep, chicken, duck and horse to hear them talk; then find the one the voice asks for. | Animal names and sounds, listening |
| 🐮 **Animal Call** *(microphone)* | "What does the cow say?" Moo, baa or quack loud enough and the animal dances. Only the loudness is measured, nothing is recorded. | Animal sounds, speaking confidence |
| 🔤 **Alphabet Trail** *(touch)* | Trace each capital letter along a dotted guide, scooping up diamonds with a finger; the letter lights up and the voice says “A is for apple”. | Letter shapes and names, fine motor |
| ✏️ **Path Tracer** *(touch)* | Follow lines, circles, zigzags, then stars, hearts, spirals and little pictures, catching balls along the path. | Shapes, pre-writing strokes |
| 🌳 **Shake the Tree** *(motion)* | Shake the tablet (or drag the tree on a laptop): apples fall one by one and the voice counts them to ten. | Counting, cause and effect |

Every game in the catalogue is playable. Camera games share one shell (camera + tracking +
parent gate); touch, microphone and motion games share a lighter shell (`ActivityShell`) with
the same session timer, break screen and settings. The complete idea list lives in
[docs/IDEAS.md](docs/IDEAS.md).

## Designed for tiny hands (and feet, and heads)

- **Whole-body play.** A single "interaction mode" in settings applies to every game: 🧍 whole body (default — hands,
  head, feet and tummy all count, ideal for children who cannot point yet), 🖐️ wave a hand, ☝️ point a finger, or 🙂 head only.
- **No wrong answers, no losing.** Every action is rewarded with sound, sparkle and a friendly voice. Scores are shown but never matter.
- **No keyboard, no mouse.** Hand and body tracking run in the browser; colour buttons are chosen by hovering.
- **Parent gate.** Any button that leaves a game must be pressed and *held*, so curious taps do nothing.
- **Gentle endings.** After about five minutes a "bye bye" screen appears; a grown-up can hold for five more.
- **Private by default.** Camera frames never leave the device. Nothing is recorded or uploaded.
- **Offline capable.** The MediaPipe model and WASM runtime are served from the site itself, not a CDN.

## Settings (for grown-ups)

Open the ⚙️ **Settings** drawer from the hub header, or inside a game by **pressing and holding**
the gear for one second (the parent gate). Everything is saved on the device.

| Section | What you can change |
|---------|---------------------|
| 🔊 Sound | Sound effects up to **300 %** (a limiter stops distortion), spoken words on/off, voice volume |
| 🧒 How your child plays | **Interaction mode**: whole body / wave a hand / point a finger / head only. Applies to every game. |
| 📷 Camera & tracking | **Responsiveness** (smooth ↔ snappy), camera quality (lower = faster), hands tracked (one is fastest), cursor on the tracked part, **how visible you are behind the game** (default 50 %), FPS readout |
| ⏰ Session | Minutes of play before the bye-bye screen |
| 🫧 Wave to Pop | Bubbles on screen, how often they appear, size, rise speed |
| 🍉 Fruit Slice | Fruit in the air, how often they launch, speed, size, slice accuracy (fine / normal / near miss OK) |
| ⭐ Catch the Stars | Fall speed, how often stars appear, basket width, star size |
| 🖌️ Air Painting | Brush size, hover time to pick a colour, whether a fist lifts the brush |
| 🐱 Tickle the Cat | Cats at once, how often they appear, size, how long they wait |
| ✈️ Fly High | Balloon frequency, flying speed, aeroplane size |
| 🚌 Bus Driver | Passenger frequency, bus size |
| 🚍 Beep Meow Whoosh | Things on screen, speed, size, whether "Where is the…?" questions are asked |

### If hand tracking feels laggy

1. Turn **Responsiveness** up. Smoothing now adapts to speed and adds a little motion prediction, so fast swipes follow the hand almost instantly.
2. Set **Camera quality** to *Low* and **Hands tracked** to *One*. The model looks at a tiny image anyway.
3. Switch on **Show tracking speed** to see the FPS. Under ~20 fps, close other tabs, plug the laptop in, and make sure the browser is using the GPU (`chrome://gpu`).
4. Use Chrome or Edge. Safari and Firefox run the model on the CPU and are noticeably slower.

## The 3D layer (img2threejs)

None of the 3D models are downloaded assets. The mascot, the bus, the aeroplane and the cat were
each rebuilt from their sticker art as **code-only procedural Three.js** with the
[img2threejs](https://github.com/img2threejs/img2threejs) skill: a measured sculpt spec
(`3d/<model>/object-sculpt-spec.json`, authored by `3d/<model>/author-spec.py` from pixel
measurements of the reference) drives a generated TypeScript factory in `src/models/<model>/` with
sockets, colliders and animation pivots. Every build pass was gated by screenshots against the
reference (silhouette IoU: mascot 0.89, bus 0.94, plane 0.90, cat 0.90; plus turntable,
self-intersection and part-coverage gates) and the review trail lives in each spec's
`reviewHistory`.

- **Mascot** — 13-bone skeleton driven live from MediaPipe pose landmarks (Wiggle Mirror).
- **Bus** — extruded measured side profile, spinning wheel pivots and a hinged door that swings
  open with its panes.
- **Aeroplane** — lathe fuselage on the measured axis with a drooping nose cap; the far wing sits
  where the sticker cheats it, and the whole plane banks and pitches through the fuselage node.
- **Cat** — head and body revolved from the reference's row-by-row widths; the head turns with
  its whole face, the tail wags about its root, ears and forelegs hinge.

3D Toy Town puts the three props in one scene (`src/games/toy-town/`): the pure logic in
`logic.ts` moves the bus and plane, detects touches with a toddler-generous radius and runs the
"Where is the…?" prompts, and the component maps the tracked pointer onto the projected props.

Tooling that supports it:

- `/#/lab/<model>` — deterministic review viewer (named camera views, unlit and shadow-free modes,
  mesh/part/pose export hooks for the gates).
- `3d/tools/run-pass.sh <model> <pass>` — regenerates a pass, captures the review batch with the
  installed Chrome (on a dark neutral background so white parts register) and runs every
  deterministic gate; `3d/tools/record-pass.sh` records the review and advances the state.
- `3d/<model>/tool-notes.md` — two small local patches to the img2threejs clone (textureless
  materials in the material gate, a presence fallback in the colour gate), both candidates for
  upstream pull requests.

## Tech stack

- [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision) hand landmarker and pose landmarker (on-device, WebGL/WASM)
- Web Audio `AnalyserNode` for the microphone loudness meter and `devicemotion` for shaking, both on-device only
- [Three.js](https://threejs.org) for the procedural 3D mascot and props, generated with img2threejs
- HTML canvas for rendering, Web Audio for procedural sound effects, Web Speech for the voice
- [Vitest](https://vitest.dev) + Testing Library for tests, [oxlint](https://oxc.rs) for linting
- GitHub Actions → GitHub Pages for hosting
- Character and fruit art generated with AI (Higgsfield / Nano Banana), background-removed and packed as WebP

## Getting started

```bash
npm install        # also copies the MediaPipe WASM runtime into public/
npm run dev        # http://localhost:5173 (use --host to test on a tablet on the same Wi-Fi)
```

> Camera access requires a secure context: `localhost` is fine, but on a tablet over the
> LAN you need HTTPS. The quickest option is `npx vite --host` plus a tool like
> `mkcert`, or simply deploy to GitHub Pages and open the live URL.

Other scripts:

```bash
npm run check          # lint + typecheck + tests + build
npm run test:coverage  # unit tests with coverage report
npm run build          # production build into dist/
npm run preview        # serve the production build locally
npm run e2e:smoke      # drives every game in real Chrome with a fake camera (needs `npm run dev` running)
```

The smoke test uses the Chrome installed on your machine (`playwright-core` with `channel: 'chrome'`),
grants a fake webcam, presses Play in each game and checks that the camera, the MediaPipe model and
the game loop all come up. Screenshots land in `e2e/screenshots/`.

## Project structure

```
src/
  config/        site identity and the game catalogue (categories, age bands, interests)
  lib/
    tracking/    interaction modes, the Pointer abstraction, unified tracking hook
    hands/       MediaPipe hand wrapper, hand pointers, smoothing, gesture features
    pose/        MediaPipe pose wrapper, body-part pointers (hands, head, feet, torso)
    camera/      getUserMedia hook
    game/        game loop, canvas sizing, particles, dwell selection, collision, RNG
    audio/       procedural sound effects (with master volume + limiter) and speech
    settings/    schema + validation, localStorage persistence, React context
    storage/     local progress log (feeds the future adaptive layer)
  components/
    game/        GameShell (camera + tracking + parent gate), overlays, HUD
    settings/    settings drawer, sliders/toggles, per-game sections
  desktop/       Electron shell (offline installers for Windows and macOS)
  mobile/        Expo shell (Android and iOS apps)
    catalogue/   game cards and filters for the hub page
    layout/      header and footer
  models/        procedural Three.js factories (generated + refined) and the shared stage lighting
  lab/           deterministic model viewer used for img2threejs review captures
  games/
    <game>/logic.ts      pure, fully tested game state functions
    <game>/<Game>.tsx    canvas rendering + audio wiring
  pages/         Home, Game, Parents
public/
  models/        hand_landmarker.task and pose_landmarker_lite.task (downloaded once, committed)
  mediapipe/     WASM runtime, copied from node_modules at install time (git-ignored)
docs/IDEAS.md    full idea catalogue and roadmap
```

Every game keeps its rules in a pure `logic.ts` (immutable state in, new state + events out),
which is where the tests live. The React component only draws and plays sounds.

## Deploying

Pushing to `main` runs lint, typecheck, tests and build, then publishes `dist/` to GitHub Pages.
Enable **Settings → Pages → Source: GitHub Actions** once in the repository settings.

The workflow sets `VITE_BASE_PATH=/<repo-name>/` automatically. For a custom domain or a
user site, set `VITE_BASE_PATH=/` instead.

## Desktop and mobile apps

The web app is the single source of truth; two thin shells wrap the same build so it can be
installed and played **without an internet connection**.

### Windows and macOS (`desktop/`, Electron)

```bash
cd desktop
npm install
npm start          # builds the web app, bundles it and opens the desktop window
npm run smoke      # launches the app with a fake camera and checks nothing leaves the machine
npm run smoke:updates  # drives check → download → relaunch against a local update server
npm run dist:mac   # DMG + zip for Apple Silicon and Intel (release/)
npm run dist:win   # NSIS installer + portable exe (release/)
```

- The app is served from its own `wiggleplay://` scheme, a secure context, so the camera and the
  WASM runtime work offline. Every http(s) request is blocked, including MediaPipe's telemetry
  ping; fonts are self-hosted.
- **Runtime check.** On every start the app verifies the MediaPipe runtime and the two landmark
  models (`desktop/src/assets.ts`). They ship inside the installer, but a `npm run build:web:lite`
  build leaves them out to keep the download small: the setup screen then fetches them once from
  the published site into the user's app-data folder with a progress bar, and never again.
- Installers are unsigned; on macOS right-click → Open the first time. The `Desktop installers`
  GitHub Actions workflow builds both platforms when a `desktop-v*` tag is pushed.

### Android and iOS (`mobile/`, Expo)

```bash
cd mobile
npm install
npm run ios                      # builds the web app, packs it into assets/web.zip, prebuilds and runs on a simulator
scripts/build-android-apk.sh     # self-contained Android APK (release variant) for phones and emulators
npm run android                  # developer loop against a Metro server (the *debug* APK is not portable)
```

Only the **release** APK (`android/app/build/outputs/apk/release/app-release.apk`) carries the
JavaScript bundle; a debug APK shows "Unable to load script" unless a Metro dev server is
reachable. `node scripts/collect-builds.mjs` (repo root) copies every installable build into
`builds/` with platform names.

- The whole web build (games, art, MediaPipe runtime, models: ~38 MB) travels inside the app as
  one zip asset. On first launch it is unpacked into the app's documents folder and served by a
  tiny localhost server (`@dr.pogodin/react-native-static-server`) into a WebView, because a
  loopback http origin is a secure context and the camera works there while `file://` does not.
  The unpacked copy is stamped with the bundle version and refreshed when the app updates.
- Camera and microphone permissions are requested up front (`expo-camera`); the WebView is
  locked to the local origin so the child can never leave the games.
- The native projects are generated by `expo prebuild` (they are git-ignored); store builds go
  through `eas build` or Xcode / Android Studio on the generated projects.

### In-app updates (offline first, never nagging)

"Offline" means the games never need the internet to play, not that the apps are frozen in time.
Every build can pull new games without a reinstall, and nothing is downloaded until a parent asks:

- CI publishes every push to `main` twice: the website, and a content bundle at
  `updates/manifest.json` + `updates/web-<version>.zip` next to it (`scripts/pack-web-bundle.mjs`;
  the version is a sortable `YYYYMMDDHHMMSS-<commit>` stamp with a SHA-256 of the zip).
- The desktop and mobile apps check that manifest quietly a few seconds after start (a failed
  check while offline is silent). Parents open **Settings → Updates** to see the running bundle
  version, press **Download the new games**, then **Restart now**. The download is verified against
  the hash before it replaces anything; a bad or interrupted download leaves the old games intact.
- The website itself needs nothing: reloading the page is the update.
- The desktop *shell* (Electron) is also versioned: on Windows the app can install a newer shell
  from the GitHub release through electron-updater; on macOS (unsigned builds) the Updates section
  shows a link to the download page instead. Tag `desktop-v*` to publish a shell release.
- Test the whole desktop loop locally with `npm run smoke:updates` in `desktop/`
  (local update server → check → download → relaunch on the new bundle).

## About the author

WigglePlay is made by [Atul Tiwari](https://github.com/atultiwari), a parent who wanted his toddler's unavoidable
screen time to be active and educational. Every design decision — whole-body play, no failure states, hidden
grown-up controls, loud happy sounds, on-device privacy — follows from that. Contributions and ideas are welcome.

## Roadmap

1. **Shared kit** ✅ big-button engine, character voice, reward effects, progress log
2. **Camera games** ✅ Air Painting, Catch the Stars, Wave to Pop, Fruit Slice
3. **Whole-body play + themed games** ✅ pose tracking, Tickle the Cat, Fly High, Bus Driver, Beep Meow Whoosh
4. **3D layer** ✅ procedural mascot puppet (img2threejs) + Wiggle Mirror; ✅ bus, aeroplane and cat as animated 3D props + 3D Toy Town; next: a 3D Fly High / Bus Driver using the props and more toys
5. **Touch, voice and motion** ✅ Simon Says Mirror, Tap the Farm, Animal Call (microphone loudness), Shake the Tree (device motion with a drag fallback)
6. **Tracing games** ✅ Alphabet Trail and Path Tracer (shared engine in `src/lib/trace/`)
7. **Next:** tap-along rhymes, bilingual voice (English + home language), lowercase letters and numbers in the trail
8. Adaptive layer: skill graph per child, AI-picked next activity, parent summary
9. More age bands (3–4, 4–5) and interest-based playlists

See [docs/IDEAS.md](docs/IDEAS.md) for the full list.

## License

MIT © Atul Tiwari
