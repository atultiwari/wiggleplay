import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { NAMED_COLORS, type NamedColor } from '../../lib/game/colors'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import type { FlyHighSettings } from '../../lib/settings/schema'
import { clamp, distance, lerp } from '../../lib/math/vec'

export interface Balloon {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly r: number
  readonly vx: number
  readonly color: NamedColor
}

export interface Cloud {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly size: number
  readonly vx: number
}

export interface FlyState {
  readonly planeY: number
  readonly planeVy: number
  readonly balloons: readonly Balloon[]
  readonly clouds: readonly Cloud[]
  /** Balloons in the current run to ten. */
  readonly count: number
  readonly total: number
  readonly spawnInSec: number
  readonly cloudInSec: number
  readonly celebrationSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
}

export interface FlyConfig {
  readonly balloonIntervalSec: number
  readonly speedScale: number
  readonly planeSize: number
}

export interface FlyInput {
  readonly targetY: number | null
  readonly width: number
  readonly height: number
  readonly config?: FlyConfig
}

export interface FlyEvents {
  readonly collected: readonly number[]
  readonly celebrated: boolean
}

export const COUNT_TARGET = 10
export const PLANE_X_RATIO = 0.3
export const PLANE_BASE_SIZE = 170
export const BALLOON_RADIUS = [34, 52] as const
const BALLOON_SPEED = 150
const CLOUD_SPEED = 45
const CLOUD_INTERVAL_SEC = 2.4
const FOLLOW = 0.22
const TOP_MARGIN = 100
const CELEBRATION_SEC = 2.4

export const DEFAULT_FLY_CONFIG: FlyConfig = { balloonIntervalSec: 1.4, speedScale: 1, planeSize: PLANE_BASE_SIZE }

export const configFromSettings = (settings: FlyHighSettings): FlyConfig => ({
  balloonIntervalSec: settings.balloonIntervalSec,
  speedScale: settings.speed,
  planeSize: PLANE_BASE_SIZE * settings.planeSize,
})

export const createFlyState = (height: number): FlyState => ({
  planeY: height / 2,
  planeVy: 0,
  balloons: [],
  clouds: [],
  count: 0,
  total: 0,
  spawnInSec: 0.8,
  cloudInSec: 0.2,
  celebrationSec: 0,
  particles: [],
  nextId: 1,
})

export const planeX = (width: number): number => width * PLANE_X_RATIO

export const spawnBalloon = (width: number, height: number, id: number, rng: Rng, config: FlyConfig = DEFAULT_FLY_CONFIG): Balloon => {
  const r = randomBetween(BALLOON_RADIUS[0], BALLOON_RADIUS[1], rng)
  return {
    id,
    x: width + r,
    y: randomBetween(TOP_MARGIN + r, Math.max(TOP_MARGIN + r, height - r), rng),
    r,
    vx: -BALLOON_SPEED * config.speedScale,
    color: pickOne(NAMED_COLORS, rng),
  }
}

export const spawnCloud = (width: number, height: number, id: number, rng: Rng, config: FlyConfig = DEFAULT_FLY_CONFIG): Cloud => {
  const size = randomBetween(90, 200, rng)
  return {
    id,
    x: width + size,
    y: randomBetween(TOP_MARGIN, Math.max(TOP_MARGIN, height - size / 2), rng),
    size,
    vx: -CLOUD_SPEED * config.speedScale * randomBetween(0.7, 1.3, rng),
  }
}

export const stepFly = (
  state: FlyState,
  dtSec: number,
  input: FlyInput,
  rng: Rng = Math.random,
): { readonly state: FlyState; readonly events: FlyEvents } => {
  const config = input.config ?? DEFAULT_FLY_CONFIG
  const half = config.planeSize / 2
  const minY = TOP_MARGIN + half * 0.6
  const maxY = Math.max(minY, input.height - half * 0.6)
  const targetY = clamp(input.targetY ?? input.height / 2, minY, maxY)
  const planeY = lerp(state.planeY, targetY, FOLLOW)
  const planeVy = (planeY - state.planeY) / Math.max(dtSec, 1 / 240)
  const plane = { x: planeX(input.width), y: planeY }

  const movedBalloons = state.balloons.map((b) => ({ ...b, x: b.x + b.vx * dtSec }))
  const collectedBalloons = movedBalloons.filter((b) => distance(plane, b) <= half * 0.75 + b.r)
  const balloons = movedBalloons.filter((b) => !collectedBalloons.includes(b) && b.x > -b.r)
  const clouds = state.clouds.map((c) => ({ ...c, x: c.x + c.vx * dtSec })).filter((c) => c.x > -c.size)

  const collected: number[] = []
  let count = state.count
  let celebrated = false
  collectedBalloons.forEach(() => {
    count += 1
    collected.push(count)
    if (count >= COUNT_TARGET) {
      celebrated = true
      count = 0
    }
  })

  const bursts = collectedBalloons.flatMap((b) =>
    spawnBurst({ x: b.x, y: b.y }, { count: 16, colors: [b.color.hex, '#ffffff'], speed: [80, 280], size: [4, 9], gravity: 300 }, rng),
  )
  const confetti = celebrated
    ? spawnBurst({ x: plane.x, y: plane.y }, { count: 110, colors: NAMED_COLORS.map((c) => c.hex), speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 }, rng)
    : []

  let nextId = state.nextId
  let spawnInSec = state.spawnInSec - dtSec
  let nextBalloons = balloons
  const celebrationSec = celebrated ? CELEBRATION_SEC : Math.max(0, state.celebrationSec - dtSec)
  if (spawnInSec <= 0 && celebrationSec === 0 && input.width > 0) {
    nextBalloons = [...balloons, spawnBalloon(input.width, input.height, nextId, rng, config)]
    nextId += 1
    spawnInSec = config.balloonIntervalSec
  }
  let cloudInSec = state.cloudInSec - dtSec
  let nextClouds = clouds
  if (cloudInSec <= 0 && input.width > 0) {
    nextClouds = [...clouds, spawnCloud(input.width, input.height, nextId, rng, config)]
    nextId += 1
    cloudInSec = CLOUD_INTERVAL_SEC / config.speedScale
  }

  return {
    state: {
      planeY,
      planeVy,
      balloons: nextBalloons,
      clouds: nextClouds,
      count,
      total: state.total + collectedBalloons.length,
      spawnInSec,
      cloudInSec,
      celebrationSec,
      particles: [...stepParticles(state.particles, dtSec), ...bursts, ...confetti],
      nextId,
    },
    events: { collected, celebrated },
  }
}
