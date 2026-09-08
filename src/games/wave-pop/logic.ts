import type { HandPose } from '../../types/hand'
import { circleContainsPoint } from '../../lib/game/collision'
import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import type { WavePopSettings } from '../../lib/settings/schema'

export interface BubbleColor {
  readonly name: string
  readonly hex: string
}

export const BUBBLE_COLORS: readonly BubbleColor[] = [
  { name: 'Red', hex: '#ff4d6d' },
  { name: 'Orange', hex: '#ff9f1c' },
  { name: 'Yellow', hex: '#ffd60a' },
  { name: 'Green', hex: '#3ddc84' },
  { name: 'Blue', hex: '#3a86ff' },
  { name: 'Purple', hex: '#9b5de5' },
  { name: 'Pink', hex: '#ff70b8' },
]

export interface Bubble {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly r: number
  readonly vy: number
  readonly wobbleAmp: number
  readonly wobblePhase: number
  readonly color: BubbleColor
}

export interface PopState {
  readonly bubbles: readonly Bubble[]
  readonly popped: number
  readonly spawnInSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
  readonly timeSec: number
}

/** Tunable rules, derived from the parent settings. */
export interface PopConfig {
  readonly maxBubbles: number
  readonly spawnIntervalSec: number
  readonly sizeScale: number
  readonly speedScale: number
  /** Extra reach (px) so a near miss still pops. */
  readonly hitMarginPx: number
}

export interface PopInput {
  readonly hands: readonly HandPose[]
  readonly width: number
  readonly height: number
  readonly config?: PopConfig
}

export interface PopEvents {
  readonly popped: readonly Bubble[]
  readonly milestone: boolean
}

export const MILESTONE_EVERY = 10
export const BUBBLE_RADIUS = [46, 80] as const
const RISE_SPEED = [40, 90] as const

export const DEFAULT_POP_CONFIG: PopConfig = {
  maxBubbles: 7,
  spawnIntervalSec: 0.9,
  sizeScale: 1,
  speedScale: 1,
  hitMarginPx: 18,
}

export const configFromSettings = (settings: WavePopSettings): PopConfig => ({
  maxBubbles: settings.maxBubbles,
  spawnIntervalSec: settings.spawnIntervalSec,
  sizeScale: settings.bubbleSize,
  speedScale: settings.riseSpeed,
  hitMarginPx: DEFAULT_POP_CONFIG.hitMarginPx,
})

export const createPopState = (): PopState => ({
  bubbles: [],
  popped: 0,
  spawnInSec: 0.4,
  particles: [],
  nextId: 1,
  timeSec: 0,
})

export const spawnBubble = (
  width: number,
  height: number,
  id: number,
  rng: Rng,
  config: PopConfig = DEFAULT_POP_CONFIG,
): Bubble => {
  const r = randomBetween(BUBBLE_RADIUS[0], BUBBLE_RADIUS[1], rng) * config.sizeScale
  return {
    id,
    x: randomBetween(r, Math.max(r, width - r), rng),
    y: height + r,
    r,
    vy: -randomBetween(RISE_SPEED[0], RISE_SPEED[1], rng) * config.speedScale,
    wobbleAmp: randomBetween(8, 28, rng),
    wobblePhase: randomBetween(0, Math.PI * 2, rng),
    color: pickOne(BUBBLE_COLORS, rng),
  }
}

/** Horizontal position including the gentle side-to-side wobble. */
export const bubbleDrawX = (bubble: Bubble, timeSec: number): number =>
  bubble.x + Math.sin(timeSec * 1.6 + bubble.wobblePhase) * bubble.wobbleAmp

const touchedByHands = (bubble: Bubble, timeSec: number, hands: readonly HandPose[], margin: number): boolean => {
  const centre = { x: bubbleDrawX(bubble, timeSec), y: bubble.y }
  return hands.some((hand) => hand.points.some((p) => circleContainsPoint(centre, bubble.r + margin, p)))
}

export const stepPop = (
  state: PopState,
  dtSec: number,
  input: PopInput,
  rng: Rng = Math.random,
): { readonly state: PopState; readonly events: PopEvents } => {
  const config = input.config ?? DEFAULT_POP_CONFIG
  const timeSec = state.timeSec + dtSec
  const risen = state.bubbles.map((b) => ({ ...b, y: b.y + b.vy * dtSec }))
  const alive = risen.filter((b) => b.y > -b.r)
  const popped = alive.filter((b) => touchedByHands(b, timeSec, input.hands, config.hitMarginPx))
  const remaining = alive.filter((b) => !popped.includes(b))

  const bursts = popped.flatMap((b) =>
    spawnBurst(
      { x: bubbleDrawX(b, timeSec), y: b.y },
      { count: 16, colors: [b.color.hex, '#ffffff'], speed: [80, 260], size: [3, 8], life: [0.4, 0.8], gravity: 350 },
      rng,
    ),
  )

  let spawnInSec = state.spawnInSec - dtSec
  let bubbles = remaining
  let nextId = state.nextId
  if (spawnInSec <= 0 && bubbles.length < config.maxBubbles && input.width > 0) {
    bubbles = [...bubbles, spawnBubble(input.width, input.height, nextId, rng, config)]
    nextId += 1
    spawnInSec = config.spawnIntervalSec
  }

  const total = state.popped + popped.length
  const milestone = popped.length > 0 && Math.floor(total / MILESTONE_EVERY) > Math.floor(state.popped / MILESTONE_EVERY)

  return {
    state: {
      bubbles,
      popped: total,
      spawnInSec,
      particles: [...stepParticles(state.particles, dtSec), ...bursts],
      nextId,
      timeSec,
    },
    events: { popped, milestone },
  }
}
