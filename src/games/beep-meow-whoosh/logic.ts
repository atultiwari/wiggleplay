import type { Pointer } from '../../types/pointer'
import { circleContainsPoint } from '../../lib/game/collision'
import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import type { BeepMeowSettings } from '../../lib/settings/schema'

export type ThingKind = 'plane' | 'bus' | 'cat'
export type ThingArt = 'plane' | 'bus' | 'catOrange' | 'catGrey' | 'catBlack'

export interface ThingInfo {
  readonly name: string
  readonly sound: string
  readonly emoji: string
  /** Lane as a share of the screen height. */
  readonly laneY: number
  readonly direction: 1 | -1
  readonly speed: number
  readonly size: number
  readonly arts: readonly ThingArt[]
}

export const THING_INFO: Readonly<Record<ThingKind, ThingInfo>> = {
  plane: { name: 'Aeroplane', sound: 'Whoosh', emoji: '✈️', laneY: 0.24, direction: 1, speed: 150, size: 170, arts: ['plane'] },
  cat: { name: 'Cat', sound: 'Meow', emoji: '🐱', laneY: 0.55, direction: -1, speed: 70, size: 150, arts: ['catOrange', 'catGrey', 'catBlack'] },
  bus: { name: 'Bus', sound: 'Beep beep', emoji: '🚌', laneY: 0.83, direction: 1, speed: 110, size: 210, arts: ['bus'] },
}

export const THING_KINDS = Object.keys(THING_INFO) as readonly ThingKind[]

export interface Thing {
  readonly id: number
  readonly kind: ThingKind
  readonly art: ThingArt
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly size: number
  /** Seconds since last poke; drives the bounce and the poke cooldown. */
  readonly pokedSec: number
}

export interface Prompt {
  readonly kind: ThingKind
  readonly remainingSec: number
}

export interface BeepState {
  readonly things: readonly Thing[]
  readonly poked: number
  readonly found: number
  readonly prompt: Prompt | null
  readonly promptInSec: number
  readonly spawnInSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
}

export interface BeepConfig {
  readonly maxThings: number
  readonly speedScale: number
  readonly sizeScale: number
  readonly askQuestions: boolean
  readonly hitMarginPx: number
}

export interface BeepInput {
  readonly pointers: readonly Pointer[]
  readonly width: number
  readonly height: number
  readonly config?: BeepConfig
}

export interface BeepEvents {
  readonly poked: readonly Thing[]
  readonly asked: ThingKind | null
  readonly found: ThingKind | null
}

export const POKE_COOLDOWN_SEC = 0.9
export const BOUNCE_SEC = 0.5
export const PROMPT_SEC = 10
const FIRST_PROMPT_SEC = 8
const PROMPT_GAP_AFTER_FOUND_SEC = 7
const PROMPT_GAP_AFTER_MISS_SEC = 5
const SPAWN_INTERVAL_SEC = 1.3
const NEVER_POKED = 999

export const DEFAULT_BEEP_CONFIG: BeepConfig = { maxThings: 5, speedScale: 1, sizeScale: 1, askQuestions: true, hitMarginPx: 20 }

export const configFromSettings = (settings: BeepMeowSettings): BeepConfig => ({
  maxThings: settings.maxThings,
  speedScale: settings.speed,
  sizeScale: settings.thingSize,
  askQuestions: settings.askQuestions,
  hitMarginPx: DEFAULT_BEEP_CONFIG.hitMarginPx,
})

export const createBeepState = (): BeepState => ({
  things: [],
  poked: 0,
  found: 0,
  prompt: null,
  promptInSec: FIRST_PROMPT_SEC,
  spawnInSec: 0.3,
  particles: [],
  nextId: 1,
})

export const spawnThing = (width: number, height: number, id: number, rng: Rng, config: BeepConfig = DEFAULT_BEEP_CONFIG, kind?: ThingKind): Thing => {
  const chosen = kind ?? pickOne(THING_KINDS, rng)
  const info = THING_INFO[chosen]
  const size = info.size * config.sizeScale
  return {
    id,
    kind: chosen,
    art: pickOne(info.arts, rng),
    x: info.direction === 1 ? -size : width + size,
    y: height * info.laneY + randomBetween(-20, 20, rng),
    vx: info.direction * info.speed * config.speedScale * randomBetween(0.85, 1.15, rng),
    size,
    pokedSec: NEVER_POKED,
  }
}

/** Vertical hop offset (px) and scale bump right after a poke. */
export const bounce = (thing: Thing): { readonly lift: number; readonly scale: number } => {
  if (thing.pokedSec >= BOUNCE_SEC) return { lift: 0, scale: 1 }
  const t = Math.sin((thing.pokedSec / BOUNCE_SEC) * Math.PI)
  return { lift: t * 36, scale: 1 + t * 0.2 }
}

const isTouched = (thing: Thing, pointers: readonly Pointer[], margin: number): boolean =>
  pointers.some((p) => p.points.some((point) => circleContainsPoint(thing, thing.size / 2 + margin, point)))

export const stepBeep = (
  state: BeepState,
  dtSec: number,
  input: BeepInput,
  rng: Rng = Math.random,
): { readonly state: BeepState; readonly events: BeepEvents } => {
  const config = input.config ?? DEFAULT_BEEP_CONFIG
  const moved = state.things
    .map((t) => ({ ...t, x: t.x + t.vx * dtSec, pokedSec: t.pokedSec + dtSec }))
    .filter((t) => t.x > -t.size * 1.5 && t.x < input.width + t.size * 1.5)

  const poked = moved.filter((t) => t.pokedSec >= POKE_COOLDOWN_SEC && isTouched(t, input.pointers, config.hitMarginPx))
  const things = moved.map((t) => (poked.includes(t) ? { ...t, pokedSec: 0 } : t))
  const sparkles = poked.flatMap((t) =>
    spawnBurst({ x: t.x, y: t.y }, { count: 12, colors: ['#ffffff', '#ffd60a'], speed: [60, 220], size: [4, 8], gravity: 250 }, rng),
  )

  let prompt = state.prompt
  let promptInSec = state.promptInSec - dtSec
  let asked: ThingKind | null = null
  let found: ThingKind | null = null
  if (prompt) {
    const hit = poked.find((t) => t.kind === prompt?.kind)
    if (hit) {
      found = prompt.kind
      prompt = null
      promptInSec = PROMPT_GAP_AFTER_FOUND_SEC
    } else if (prompt.remainingSec - dtSec <= 0) {
      prompt = null
      promptInSec = PROMPT_GAP_AFTER_MISS_SEC
    } else {
      prompt = { ...prompt, remainingSec: prompt.remainingSec - dtSec }
    }
  } else if (config.askQuestions && promptInSec <= 0 && things.length > 0) {
    const kinds = [...new Set(things.map((t) => t.kind))]
    asked = pickOne(kinds, rng)
    prompt = { kind: asked, remainingSec: PROMPT_SEC }
  }

  let spawnInSec = state.spawnInSec - dtSec
  let nextThings = things
  let nextId = state.nextId
  if (spawnInSec <= 0 && things.length < config.maxThings && input.width > 0) {
    nextThings = [...things, spawnThing(input.width, input.height, nextId, rng, config)]
    nextId += 1
    spawnInSec = SPAWN_INTERVAL_SEC / config.speedScale
  }

  return {
    state: {
      things: nextThings,
      poked: state.poked + poked.length,
      found: state.found + (found ? 1 : 0),
      prompt,
      promptInSec,
      spawnInSec,
      particles: [...stepParticles(state.particles, dtSec), ...sparkles],
      nextId,
    },
    events: { poked, asked, found },
  }
}
