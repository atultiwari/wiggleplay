import { randomBetween, type Rng } from '../../lib/game/random'
import type { ShakeTreeSettings } from '../../lib/settings/schema'

export interface Apple {
  readonly id: number
  /** Position as a fraction of the stage. */
  readonly u: number
  readonly v: number
  readonly vy: number
  readonly phase: 'hanging' | 'falling' | 'landed'
  /** Fixed spot on the ground once landed. */
  readonly landedU: number
}

export interface TreeState {
  readonly apples: readonly Apple[]
  /** How hard the tree is being shaken right now, 0..1 (drives the wobble). */
  readonly wobble: number
  readonly time: number
  readonly counted: number
  readonly cooldownSec: number
  readonly regrowSec: number
  readonly rounds: number
}

export interface TreeConfig {
  readonly appleCount: number
  readonly shakeStrength: number
}

export interface TreeInput {
  /** Device shake magnitude in m/s² (0 when unsupported). */
  readonly shake: number
  /** Finger drag speed over the tree in px/s (0 when not dragging). */
  readonly dragSpeed: number
  readonly config?: TreeConfig
}

export interface TreeEvents {
  readonly dropped: Apple | null
  readonly landed: readonly number[]
  readonly finished: boolean
  readonly regrown: boolean
}

export const GROUND_V = 0.86
export const DROP_COOLDOWN_SEC = 0.55
export const REGROW_SEC = 3.5
export const GRAVITY = 1.6
/** A full-strength shake (setting 1.0) needs about this acceleration; drags need this speed. */
export const SHAKE_FULL = 14
export const DRAG_FULL = 1400

export const DEFAULT_TREE_CONFIG: TreeConfig = { appleCount: 5, shakeStrength: 0.4 }

export const configFromSettings = (settings: ShakeTreeSettings): TreeConfig => ({ appleCount: settings.appleCount, shakeStrength: settings.shakeStrength })

/** Apple spots around the canopy (fractions of the stage), chosen so up to ten apples never overlap. */
const SLOTS: readonly (readonly [number, number])[] = [
  [0.42, 0.24],
  [0.58, 0.22],
  [0.34, 0.34],
  [0.66, 0.33],
  [0.5, 0.4],
  [0.4, 0.47],
  [0.6, 0.46],
  [0.3, 0.44],
  [0.7, 0.42],
  [0.5, 0.29],
]

export const createTreeState = (config: TreeConfig = DEFAULT_TREE_CONFIG): TreeState => ({
  apples: SLOTS.slice(0, Math.max(1, Math.min(SLOTS.length, config.appleCount))).map(([u, v], i) => ({ id: i + 1, u, v, vy: 0, phase: 'hanging', landedU: 0 })),
  wobble: 0,
  time: 0,
  counted: 0,
  cooldownSec: 0,
  regrowSec: 0,
  rounds: 0,
})

/** Shake effort 0..1 from either the device sensor or a finger drag, scaled by the difficulty setting. */
export const shakeEffort = (input: TreeInput, config: TreeConfig): number => {
  const needed = Math.max(0.1, config.shakeStrength)
  return Math.min(1, Math.max(input.shake / (SHAKE_FULL * needed), input.dragSpeed / (DRAG_FULL * needed)))
}

export const stepTree = (state: TreeState, dtSec: number, input: TreeInput, rng: Rng = Math.random): { readonly state: TreeState; readonly events: TreeEvents } => {
  const config = input.config ?? DEFAULT_TREE_CONFIG
  const effort = shakeEffort(input, config)
  const wobble = Math.max(effort, state.wobble - dtSec * 1.8)
  const time = state.time + dtSec
  const cooldownSec = Math.max(0, state.cooldownSec - dtSec)
  const hanging = state.apples.filter((apple) => apple.phase === 'hanging')

  let dropped: Apple | null = null
  let apples = state.apples
  if (effort >= 1 && cooldownSec <= 0 && hanging.length > 0) {
    const pick = hanging[Math.floor(rng() * hanging.length)]
    const landedU = 0.12 + (state.counted / Math.max(1, config.appleCount)) * 0.76 + randomBetween(-0.02, 0.02, rng)
    dropped = { ...pick, phase: 'falling', vy: 0, landedU }
    apples = apples.map((apple) => (apple.id === pick.id ? dropped! : apple))
  }

  const landed: number[] = []
  apples = apples.map((apple) => {
    if (apple.phase !== 'falling') return apple
    const vy = apple.vy + GRAVITY * dtSec
    const v = apple.v + vy * dtSec
    if (v >= GROUND_V) {
      landed.push(apple.id)
      return { ...apple, v: GROUND_V, vy: 0, phase: 'landed', u: apple.landedU }
    }
    return { ...apple, v, vy, u: apple.u + (apple.landedU - apple.u) * dtSec * 2 }
  })

  const counted = state.counted + landed.length
  const allDown = apples.every((apple) => apple.phase === 'landed')
  const finished = allDown && landed.length > 0
  let regrowSec = finished ? REGROW_SEC : state.regrowSec
  let regrown = false
  let rounds = state.rounds
  let next: TreeState['apples'] = apples
  let nextCounted = counted
  if (allDown && !finished) {
    regrowSec = Math.max(0, regrowSec - dtSec)
    if (regrowSec <= 0) {
      next = createTreeState(config).apples
      nextCounted = 0
      regrown = true
      rounds += 1
    }
  }

  return {
    state: { apples: next, wobble, time, counted: nextCounted, cooldownSec: dropped ? DROP_COOLDOWN_SEC : cooldownSec, regrowSec, rounds },
    events: { dropped, landed, finished, regrown },
  }
}

export const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
