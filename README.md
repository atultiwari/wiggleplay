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

More games (Simon Says mirror, Tap the Farm, Animal Call, Shake the Tree…) are listed as
"coming soon" in the catalogue. The complete idea list lives in [docs/IDEAS.md](docs/IDEAS.md).

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

## Tech stack

- [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision) hand landmarker and pose landmarker (on-device, WebGL/WASM)
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
    catalogue/   game cards and filters for the hub page
    layout/      header and footer
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

## About the author

WigglePlay is made by [Atul Tiwari](https://github.com/atultiwari), a parent who wanted his toddler's unavoidable
screen time to be active and educational. Every design decision — whole-body play, no failure states, hidden
grown-up controls, loud happy sounds, on-device privacy — follows from that. Contributions and ideas are welcome.

## Roadmap

1. **Shared kit** ✅ big-button engine, character voice, reward effects, progress log
2. **Camera games** ✅ Air Painting, Catch the Stars, Wave to Pop, Fruit Slice
3. **Whole-body play + themed games** ✅ pose tracking, Tickle the Cat, Fly High, Bus Driver, Beep Meow Whoosh
4. **Next:** Simon Says mirror, Tap the Farm, tap-along rhymes
5. Voice games, tilt & shake games, bilingual voice (English + home language)
6. Adaptive layer: skill graph per child, AI-picked next activity, parent summary
7. More age bands (3–4, 4–5) and interest-based playlists

See [docs/IDEAS.md](docs/IDEAS.md) for the full list.

## License

MIT © Atul Tiwari
