import { lerp, type Point } from '../../lib/math/vec'
import { randomBetween, type Rng } from '../../lib/game/random'
import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import type { CatchStarsSettings } from '../../lib/settings/schema'

export interface Star {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly vy: number
  readonly rotation: number
  readonly spin: number
  readonly size: number
}

export interface CatchState {
  readonly stars: readonly Star[]
  readonly basketX: number
  /** Stars caught in the current run to ten. */
  readonly count: number
  readonly total: number
  /** Adaptive difficulty: creeps up with catches, eases off with misses. */
  readonly speedScale: number
  readonly spawnInSec: number
  readonly celebrationSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
}

/** Tunable rules, derived from the parent settings. */
export interface CatchConfig {
  readonly fallSpeedScale: number
  readonly spawnIntervalSec: number
  readonly basketWidth: number
  readonly sizeScale: number
}

export interface CatchEvents {
  /** Each entry is the new count after a catch (1..10). */
  readonly caught: readonly number[]
  readonly celebrated: boolean
  readonly missed: number
}

export interface CatchInput {
  readonly targetX: number | null
  readonly width: number
  readonly height: number
  readonly config?: CatchConfig
}

export const COUNT_TARGET = 10
export const BASKET = { width: 210, height: 96, bottomMargin: 26 } as const
export const STAR_SIZE = [64, 96] as const
const BASE_SPEED = [130, 210] as const
const CELEBRATION_SEC = 2.6
const BASKET_FOLLOW = 0.28
const SPEED_UP_PER_CATCH = 0.025
const SLOW_DOWN_PER_MISS = 0.05
const SPEED_RANGE = [0.7, 1.7] as const
export const STAR_COLORS = ['#ffd60a', '#ffb703', '#fff3b0', '#ff9f1c']

export const DEFAULT_CATCH_CONFIG: CatchConfig = {
  fallSpeedScale: 1,
  spawnIntervalSec: 1.5,
  basketWidth: BASKET.width,
  sizeScale: 1,
}

export const configFromSettings = (settings: CatchStarsSettings): CatchConfig => ({
  fallSpeedScale: settings.fallSpeed,
  spawnIntervalSec: settings.spawnIntervalSec,
  basketWidth: BASKET.width * settings.basketWidth,
  sizeScale: settings.starSize,
})

export const createCatchState = (width: number): CatchState => ({
  stars: [],
  basketX: width / 2,
  count: 0,
  total: 0,
  speedScale: 1,
  spawnInSec: 0.8,
  celebrationSec: 0,
  particles: [],
  nextId: 1,
})

export const spawnStar = (
  width: number,
  speedScale: number,
  id: number,
  rng: Rng,
  config: CatchConfig = DEFAULT_CATCH_CONFIG,
): Star => {
  const size = randomBetween(STAR_SIZE[0], STAR_SIZE[1], rng) * config.sizeScale
  return {
    id,
    x: randomBetween(size, Math.max(size, width - size), rng),
    y: -size,
    vy: randomBetween(BASE_SPEED[0], BASE_SPEED[1], rng) * speedScale * config.fallSpeedScale,
    rotation: randomBetween(0, Math.PI * 2, rng),
    spin: randomBetween(-1.5, 1.5, rng),
    size,
  }
}

export const basketTop = (height: number): number => height - BASKET.bottomMargin - BASKET.height

const isCaught = (star: Star, basketX: number, basketWidth: number, height: number): boolean => {
  const top = basketTop(height)
  const withinY = star.y >= top - star.size * 0.15 && star.y <= top + BASKET.height * 0.55
  const withinX = Math.abs(star.x - basketX) <= basketWidth / 2 + star.size * 0.2
  return withinY && withinX
}

const clampSpeed = (speed: number): number => Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], speed))

export const stepCatch = (
  state: CatchState,
  dtSec: number,
  input: CatchInput,
  rng: Rng = Math.random,
): { readonly state: CatchState; readonly events: CatchEvents } => {
  const config = input.config ?? DEFAULT_CATCH_CONFIG
  // With no hand in view the basket drifts back to the middle, ready for the next wave.
  const targetX = input.targetX ?? input.width / 2
  const basketX = lerp(state.basketX, targetX, BASKET_FOLLOW)
  const moved = state.stars.map((s) => ({ ...s, y: s.y + s.vy * dtSec, rotation: s.rotation + s.spin * dtSec }))

  const caughtStars = moved.filter((s) => isCaught(s, basketX, config.basketWidth, input.height))
  const missedStars = moved.filter((s) => !caughtStars.includes(s) && s.y > input.height + s.size)
  const remaining = moved.filter((s) => !caughtStars.includes(s) && !missedStars.includes(s))

  const caught: number[] = []
  let count = state.count
  let celebrated = false
  caughtStars.forEach(() => {
    count += 1
    caught.push(count)
    if (count >= COUNT_TARGET) {
      celebrated = true
      count = 0
    }
  })

  const bursts = caughtStars.flatMap((s) =>
    spawnBurst({ x: s.x, y: s.y }, { count: 14, colors: STAR_COLORS, speed: [90, 300], size: [4, 9], gravity: 400 }, rng),
  )
  const confetti = celebrated
    ? spawnBurst(
        { x: input.width / 2, y: input.height / 3 },
        { count: 120, colors: ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8'], speed: [150, 500], size: [5, 11], life: [1.2, 2.4], gravity: 300 },
        rng,
      )
    : []

  const speedScale = clampSpeed(
    state.speedScale + caughtStars.length * SPEED_UP_PER_CATCH - missedStars.length * SLOW_DOWN_PER_MISS,
  )
  const celebrationSec = celebrated ? CELEBRATION_SEC : Math.max(0, state.celebrationSec - dtSec)

  let spawnInSec = state.spawnInSec - dtSec
  let stars = remaining
  let nextId = state.nextId
  if (spawnInSec <= 0 && celebrationSec === 0 && input.width > 0) {
    stars = [...stars, spawnStar(input.width, speedScale, nextId, rng, config)]
    nextId += 1
    spawnInSec = config.spawnIntervalSec / speedScale
  }

  return {
    state: {
      stars,
      basketX,
      count,
      total: state.total + caughtStars.length,
      speedScale,
      spawnInSec,
      celebrationSec,
      particles: [...stepParticles(state.particles, dtSec), ...bursts, ...confetti],
      nextId,
    },
    events: { caught, celebrated, missed: missedStars.length },
  }
}

export const basketCenter = (state: CatchState, height: number): Point => ({
  x: state.basketX,
  y: basketTop(height) + BASKET.height / 2,
})
