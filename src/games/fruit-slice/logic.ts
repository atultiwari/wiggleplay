import type { HandPose } from '../../types/hand'
import { segmentIntersectsCircle } from '../../lib/game/collision'
import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import { distance, type Point } from '../../lib/math/vec'
import type { FruitSliceSettings, SliceTolerance } from '../../lib/settings/schema'

export type FruitKind = 'apple' | 'banana' | 'orange' | 'watermelon' | 'strawberry' | 'grapes'

export interface FruitInfo {
  readonly name: string
  readonly colorName: string
  readonly juice: string
}

export const FRUIT_INFO: Readonly<Record<FruitKind, FruitInfo>> = {
  apple: { name: 'Apple', colorName: 'red', juice: '#ff5c5c' },
  banana: { name: 'Banana', colorName: 'yellow', juice: '#ffe066' },
  orange: { name: 'Orange', colorName: 'orange', juice: '#ffa62b' },
  watermelon: { name: 'Watermelon', colorName: 'red and green', juice: '#ff6b81' },
  strawberry: { name: 'Strawberry', colorName: 'red', juice: '#ff4d6d' },
  grapes: { name: 'Grapes', colorName: 'purple', juice: '#b388ff' },
}

export const FRUIT_KINDS = Object.keys(FRUIT_INFO) as readonly FruitKind[]

export interface Fruit {
  readonly id: number
  readonly kind: FruitKind
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly rotation: number
  readonly spin: number
  readonly r: number
}

export interface FruitHalf {
  readonly id: number
  readonly kind: FruitKind
  readonly side: 'left' | 'right'
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly rotation: number
  readonly spin: number
  readonly r: number
  readonly life: number
}

export interface BladeTrail {
  readonly handId: number
  readonly points: readonly Point[]
}

export interface SliceState {
  readonly fruits: readonly Fruit[]
  readonly halves: readonly FruitHalf[]
  readonly particles: readonly Particle[]
  readonly trails: readonly BladeTrail[]
  readonly sliced: number
  readonly spawnInSec: number
  readonly nextId: number
}

/** Tunable rules, derived from the parent settings. */
export interface SliceConfig {
  readonly maxFruits: number
  readonly spawnIntervalSec: number
  /** 1 = normal. Higher makes fruit fly faster (same height, less time in the air). */
  readonly speedScale: number
  readonly sizeScale: number
  /** Extra reach (px) around each fruit. */
  readonly hitMarginPx: number
  /** Below this fingertip speed (px/s) a touch is a hover, not a slice. */
  readonly minSliceSpeed: number
}

export interface SliceInput {
  readonly hands: readonly HandPose[]
  readonly width: number
  readonly height: number
  readonly config?: SliceConfig
}

export interface SliceEvents {
  readonly sliced: readonly Fruit[]
  readonly milestone: boolean
}

export const GRAVITY = 820
export const FRUIT_RADIUS = [52, 78] as const
export const TRAIL_LENGTH = 12
export const MILESTONE_EVERY = 5
const HALF_LIFE_SEC = 1.4

export const SLICE_TOLERANCE: Readonly<Record<SliceTolerance, { hitMarginPx: number; minSliceSpeed: number }>> = {
  fine: { hitMarginPx: 0, minSliceSpeed: 220 },
  normal: { hitMarginPx: 14, minSliceSpeed: 140 },
  generous: { hitMarginPx: 44, minSliceSpeed: 50 },
}

export const DEFAULT_SLICE_CONFIG: SliceConfig = {
  maxFruits: 4,
  spawnIntervalSec: 1.5,
  speedScale: 1,
  sizeScale: 1,
  ...SLICE_TOLERANCE.normal,
}

export const configFromSettings = (settings: FruitSliceSettings): SliceConfig => ({
  maxFruits: settings.maxFruits,
  spawnIntervalSec: settings.spawnIntervalSec,
  speedScale: settings.speed,
  sizeScale: settings.fruitSize,
  ...SLICE_TOLERANCE[settings.tolerance],
})

export const createSliceState = (): SliceState => ({
  fruits: [],
  halves: [],
  particles: [],
  trails: [],
  sliced: 0,
  spawnInSec: 0.8,
  nextId: 1,
})

/** Gravity scaled so faster fruit still reaches the same height. */
const gravityFor = (config: SliceConfig): number => GRAVITY * config.speedScale * config.speedScale

export const launchFruit = (
  width: number,
  height: number,
  id: number,
  rng: Rng,
  config: SliceConfig = DEFAULT_SLICE_CONFIG,
): Fruit => {
  const r = randomBetween(FRUIT_RADIUS[0], FRUIT_RADIUS[1], rng) * config.sizeScale
  const x = randomBetween(width * 0.2, width * 0.8, rng)
  const apexRatio = randomBetween(0.55, 0.8, rng)
  const vy = -Math.sqrt(2 * GRAVITY * height * apexRatio) * config.speedScale
  const towardCentre = Math.sign(width / 2 - x) * randomBetween(20, 90, rng) * config.speedScale
  return {
    id,
    kind: pickOne(FRUIT_KINDS, rng),
    x,
    y: height + r,
    vx: towardCentre,
    vy,
    rotation: randomBetween(0, Math.PI * 2, rng),
    spin: randomBetween(-2, 2, rng),
    r,
  }
}

export interface BladeSegment {
  readonly a: Point
  readonly b: Point
  readonly speed: number
}

/** Turns hand fingertip trails into the blade segments swung this frame. */
export const bladeSegments = (
  previousTrails: readonly BladeTrail[],
  hands: readonly HandPose[],
  dtSec: number,
): readonly BladeSegment[] =>
  hands.flatMap((hand) => {
    const trail = previousTrails.find((t) => t.handId === hand.id)
    const last = trail?.points[trail.points.length - 1]
    if (!last) return []
    const speed = distance(last, hand.tip) / Math.max(dtSec, 1 / 240)
    return [{ a: last, b: hand.tip, speed }]
  })

export const updateTrails = (previousTrails: readonly BladeTrail[], hands: readonly HandPose[]): readonly BladeTrail[] =>
  hands.map((hand) => {
    const trail = previousTrails.find((t) => t.handId === hand.id)
    const points = [...(trail?.points ?? []), hand.tip].slice(-TRAIL_LENGTH)
    return { handId: hand.id, points }
  })

const isSliced = (fruit: Fruit, segments: readonly BladeSegment[], config: SliceConfig): boolean =>
  segments.some(
    (s) => s.speed >= config.minSliceSpeed && segmentIntersectsCircle(s.a, s.b, fruit, fruit.r + config.hitMarginPx),
  )

const splitFruit = (fruit: Fruit, nextId: number): readonly FruitHalf[] =>
  (['left', 'right'] as const).map((side, i) => ({
    id: nextId + i,
    kind: fruit.kind,
    side,
    x: fruit.x,
    y: fruit.y,
    vx: fruit.vx + (side === 'left' ? -140 : 140),
    vy: fruit.vy * 0.5 - 80,
    rotation: fruit.rotation,
    spin: side === 'left' ? -3 : 3,
    r: fruit.r,
    life: HALF_LIFE_SEC,
  }))

const moveBody = <T extends { x: number; y: number; vx: number; vy: number; rotation: number; spin: number }>(
  body: T,
  dtSec: number,
  gravity: number,
): T => ({
  ...body,
  x: body.x + body.vx * dtSec,
  y: body.y + body.vy * dtSec,
  vy: body.vy + gravity * dtSec,
  rotation: body.rotation + body.spin * dtSec,
})

export const stepSlice = (
  state: SliceState,
  dtSec: number,
  input: SliceInput,
  rng: Rng = Math.random,
): { readonly state: SliceState; readonly events: SliceEvents } => {
  const config = input.config ?? DEFAULT_SLICE_CONFIG
  const gravity = gravityFor(config)
  const segments = bladeSegments(state.trails, input.hands, dtSec)
  const trails = updateTrails(state.trails, input.hands)

  const moved = state.fruits.map((f) => moveBody(f, dtSec, gravity))
  const sliced = moved.filter((f) => isSliced(f, segments, config))
  const stillFlying = moved.filter((f) => !sliced.includes(f) && f.y < input.height + f.r * 2)

  let nextId = state.nextId
  const newHalves = sliced.flatMap((f) => {
    const halves = splitFruit(f, nextId)
    nextId += 2
    return halves
  })
  const juice = sliced.flatMap((f) =>
    spawnBurst(
      { x: f.x, y: f.y },
      { count: 22, colors: [FRUIT_INFO[f.kind].juice, '#ffffff'], speed: [120, 380], size: [4, 10], life: [0.5, 1], gravity: 600 },
      rng,
    ),
  )
  const halves = [...state.halves, ...newHalves]
    .map((h) => ({ ...moveBody(h, dtSec, gravity), life: h.life - dtSec }))
    .filter((h) => h.life > 0)

  let spawnInSec = state.spawnInSec - dtSec
  let fruits = stillFlying
  if (spawnInSec <= 0 && fruits.length < config.maxFruits && input.width > 0) {
    fruits = [...fruits, launchFruit(input.width, input.height, nextId, rng, config)]
    nextId += 1
    spawnInSec = randomBetween(config.spawnIntervalSec * 0.7, config.spawnIntervalSec * 1.3, rng)
  }

  const total = state.sliced + sliced.length
  const milestone = sliced.length > 0 && Math.floor(total / MILESTONE_EVERY) > Math.floor(state.sliced / MILESTONE_EVERY)

  return {
    state: {
      fruits,
      halves,
      particles: [...stepParticles(state.particles, dtSec), ...juice],
      trails,
      sliced: total,
      spawnInSec,
      nextId,
    },
    events: { sliced, milestone },
  }
}
