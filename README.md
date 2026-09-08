# WigglePlay — Move, Play, Learn

> Keyboard-free, camera-powered learning games for toddlers (2½ years and up).
> If screen time can't always be avoided, it can at least be active, playful and educational.

**Live site:** https://atultiwari.github.io/wiggleplay/

WigglePlay is a one-stop web app where parents pick games by **how they are played**
(camera & body, touch, voice, tilt & shake), by **age band** and by **interest**
(colours, counting, fruits, movement…). The first four games use the webcam and
on-device hand tracking, so a small child can play by simply waving at the screen.

## Games (v0.1)

| Game | How to play | What it teaches |
|------|-------------|-----------------|
| 🖌️ **Air Painting** | Point a finger at the camera to paint. Hover over a colour to pick it, make a fist to stop. | Colour names, fine motor, creativity |
| ⭐ **Catch the Stars** | Move a hand left/right; the mascot's basket follows. Stars are counted aloud to ten. | Counting to 10, tracking, gross motor |
| 🫧 **Wave to Pop** | Bubbles float over the camera picture. Touch them to pop and hear their colour. | Cause and effect, colours |
| 🍉 **Fruit Slice** | Swish a hand through flying fruit to slice it. Every fruit is named. No bombs. | Fruit names, hand-eye coordination |

More games (Simon Says mirror, Tap the Farm, Animal Call, Shake the Tree…) are listed as
"coming soon" in the catalogue. The complete idea list lives in [docs/IDEAS.md](docs/IDEAS.md).

## Designed for tiny hands

- **No wrong answers, no losing.** Every action is rewarded with sound, sparkle and a friendly voice.
- **No keyboard, no mouse.** Hand tracking runs in the browser; colour buttons are chosen by hovering.
- **Parent gate.** Any button that leaves a game must be pressed and *held*, so curious taps do nothing.
- **Gentle endings.** After about five minutes a "bye bye" screen appears; a grown-up can hold for five more.
- **Private by default.** Camera frames never leave the device. Nothing is recorded or uploaded.
- **Offline capable.** The MediaPipe model and WASM runtime are served from the site itself, not a CDN.

## Tech stack

- [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) hand landmarker (on-device, WebGL/WASM)
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
    hands/       MediaPipe wrapper, pose building, smoothing, gesture features
    camera/      getUserMedia hook
    game/        game loop, canvas sizing, particles, dwell selection, collision, RNG
    audio/       procedural sound effects and speech
    storage/     local progress log (feeds the future adaptive layer)
  components/
    game/        GameShell (camera + tracking + parent gate), overlays, HUD
    catalogue/   game cards and filters for the hub page
    layout/      header and footer
  games/
    <game>/logic.ts      pure, fully tested game state functions
    <game>/<Game>.tsx    canvas rendering + audio wiring
  pages/         Home, Game, Parents
public/
  models/        hand_landmarker.task (downloaded once, committed)
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

## Roadmap

1. **Shared kit** ✅ big-button engine, character voice, reward effects, progress log
2. **Camera games** ✅ Air Painting, Catch the Stars, Wave to Pop, Fruit Slice
3. **Next:** Simon Says mirror (pose tracking), Tap the Farm, tap-along rhymes
4. Voice games, tilt & shake games, bilingual voice (English + home language)
5. Adaptive layer: skill graph per child, AI-picked next activity, parent summary
6. More age bands (3–4, 4–5) and interest-based playlists

See [docs/IDEAS.md](docs/IDEAS.md) for the full list.

## License

MIT © Atul Tiwari
