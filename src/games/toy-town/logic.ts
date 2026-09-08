import type { Point } from '../../lib/math/vec'
import { clamp, distance } from '../../lib/math/vec'
import type { ToyTownSettings } from '../../lib/settings/schema'

/** The three procedural props that live in the town. */
export type PropKind = 'bus' | 'plane' | 'cat'
export const PROP_KINDS: readonly PropKind[] = ['bus', 'plane', 'cat']

export interface TownConfig {
  readonly propSize: number
  readonly speedScale: number
  readonly prompts: boolean
}

/** Where each prop currently appears on screen (canvas px) and how big it is, supplied by the renderer. */
export interface ScreenSpot {
  readonly x: number
  readonly y: number
  readonly r: number
}

export interface TownInput {
  readonly pointer: Point | null
  readonly spots: Readonly<Record<PropKind, ScreenSpot>>
  readonly config?: TownConfig
}

export interface TownState {
  /** Bus position along the road in world units and its driving direction. */
  readonly busX: number
  readonly busDir: 1 | -1
  readonly planeX: number
  readonly planeDir: 1 | -1
  /** Running time in seconds, used for bobbing and wagging. */
  readonly time: number
  /** Seconds of reaction animation left per prop. */
  readonly reacting: Readonly<Record<PropKind, number>>
  /** Seconds before the prop can be touched again. */
  readonly cooldown: Readonly<Record<PropKind, number>>
  readonly counts: Readonly<Record<PropKind, number>>
  readonly prompt: PropKind | null
  readonly promptInSec: number
  readonly promptRemainingSec: number
  readonly promptIndex: number
}

export interface TownEvents {
  readonly touched: readonly PropKind[]
  readonly promptAsked: PropKind | null
  readonly promptSolved: PropKind | null
  readonly promptMissed: PropKind | null
}

export const ROAD_HALF = 2.6
export const SKY_HALF = 3.2
export const BUS_SPEED = 0.55
export const PLANE_SPEED = 0.8
export const REACT_SEC = 1.4
export const COOLDOWN_SEC = 1.8
export const FIRST_PROMPT_SEC = 7
export const PROMPT_GAP_SEC = 8
export const PROMPT_TIMEOUT_SEC = 10
/** Toddler-generous hit radius: the pointer only has to come within this many prop radii. */
export const HIT_SCALE = 1.25

export const DEFAULT_TOWN_CONFIG: TownConfig = { propSize: 1, speedScale: 1, prompts: true }

export const configFromSettings = (settings: ToyTownSettings): TownConfig => ({
  propSize: settings.propSize,
  speedScale: settings.speed,
  prompts: settings.prompts,
})

const ZEROES: Readonly<Record<PropKind, number>> = { bus: 0, plane: 0, cat: 0 }

export const createTownState = (): TownState => ({
  busX: -1.2,
  busDir: 1,
  planeX: 2.4,
  planeDir: -1,
  time: 0,
  reacting: ZEROES,
  cooldown: ZEROES,
  counts: ZEROES,
  prompt: null,
  promptInSec: FIRST_PROMPT_SEC,
  promptRemainingSec: 0,
  promptIndex: 0,
})

const bounce = (x: number, dir: 1 | -1, speed: number, half: number, dtSec: number): { readonly x: number; readonly dir: 1 | -1 } => {
  const next = x + dir * speed * dtSec
  if (next > half) return { x: half, dir: -1 }
  if (next < -half) return { x: -half, dir: 1 }
  return { x: next, dir }
}

const tick = (timers: Readonly<Record<PropKind, number>>, dtSec: number): Readonly<Record<PropKind, number>> => ({
  bus: Math.max(0, timers.bus - dtSec),
  plane: Math.max(0, timers.plane - dtSec),
  cat: Math.max(0, timers.cat - dtSec),
})

/** Which props the pointer is touching right now (generous radius). */
export const propsUnderPointer = (pointer: Point | null, spots: Readonly<Record<PropKind, ScreenSpot>>): readonly PropKind[] => {
  if (!pointer) return []
  return PROP_KINDS.filter((kind) => distance(pointer, spots[kind]) <= spots[kind].r * HIT_SCALE)
}

/** Plane height above the road as it bobs across the sky. */
export const planeAltitude = (time: number): number => 1.75 + Math.sin(time * 1.3) * 0.18

/** Bank angle in radians: a gentle roll into the direction of flight plus a wobble while reacting. */
export const planeBank = (dir: 1 | -1, reactingSec: number, time: number): number =>
  -dir * 0.12 + (reactingSec > 0 ? Math.sin(time * 14) * 0.45 * (reactingSec / REACT_SEC) : 0)

/** Cat head yaw toward the pointer, clamped so the face stays visible. */
export const catHeadYaw = (pointer: Point | null, catSpot: ScreenSpot): number => {
  if (!pointer) return 0
  return clamp((pointer.x - catSpot.x) / (catSpot.r * 3), -1, 1) * 0.45
}

export const stepTown = (state: TownState, dtSec: number, input: TownInput): { readonly state: TownState; readonly events: TownEvents } => {
  const config = input.config ?? DEFAULT_TOWN_CONFIG
  const bus = bounce(state.busX, state.busDir, BUS_SPEED * config.speedScale, ROAD_HALF, dtSec)
  const plane = bounce(state.planeX, state.planeDir, PLANE_SPEED * config.speedScale, SKY_HALF, dtSec)
  const cooldown = tick(state.cooldown, dtSec)
  const reacting = tick(state.reacting, dtSec)
  const touched = propsUnderPointer(input.pointer, input.spots).filter((kind) => cooldown[kind] <= 0)

  const nextReacting = { ...reacting }
  const nextCooldown = { ...cooldown }
  const counts = { ...state.counts }
  touched.forEach((kind) => {
    nextReacting[kind] = REACT_SEC
    nextCooldown[kind] = COOLDOWN_SEC
    counts[kind] = state.counts[kind] + 1
  })

  let prompt = state.prompt
  let promptInSec = state.promptInSec
  let promptRemainingSec = state.promptRemainingSec
  let promptIndex = state.promptIndex
  let promptAsked: PropKind | null = null
  let promptSolved: PropKind | null = null
  let promptMissed: PropKind | null = null
  if (!config.prompts) {
    prompt = null
  } else if (prompt) {
    if (touched.includes(prompt)) {
      promptSolved = prompt
      prompt = null
      promptInSec = PROMPT_GAP_SEC
    } else if (promptRemainingSec - dtSec <= 0) {
      promptMissed = prompt
      prompt = null
      promptInSec = PROMPT_GAP_SEC * 0.6
    } else {
      promptRemainingSec -= dtSec
    }
  } else {
    promptInSec -= dtSec
    if (promptInSec <= 0) {
      prompt = PROP_KINDS[promptIndex % PROP_KINDS.length]
      promptIndex += 1
      promptRemainingSec = PROMPT_TIMEOUT_SEC
      promptAsked = prompt
    }
  }

  return {
    state: {
      busX: bus.x,
      busDir: bus.dir,
      planeX: plane.x,
      planeDir: plane.dir,
      time: state.time + dtSec,
      reacting: nextReacting,
      cooldown: nextCooldown,
      counts,
      prompt,
      promptInSec,
      promptRemainingSec,
      promptIndex,
    },
    events: { touched, promptAsked, promptSolved, promptMissed },
  }
}

export interface PropVoice {
  readonly name: string
  readonly touch: string
  readonly ask: string
  readonly found: string
  readonly hint: string
}

export const PROP_VOICE: Readonly<Record<PropKind, PropVoice>> = {
  bus: { name: 'bus', touch: 'Bus! Beep beep!', ask: 'Where is the bus?', found: 'Yes! That is the bus!', hint: 'Here is the bus, the yellow one!' },
  plane: { name: 'aeroplane', touch: 'Aeroplane! Whoosh!', ask: 'Where is the aeroplane?', found: 'Yes! That is the aeroplane!', hint: 'Look up! The aeroplane is in the sky.' },
  cat: { name: 'cat', touch: 'Cat! Meow!', ask: 'Where is the cat?', found: 'Yes! That is the cat!', hint: 'Here is the cat, the orange one!' },
}
