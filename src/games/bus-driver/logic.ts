import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import type { BusDriverSettings } from '../../lib/settings/schema'
import { lerp } from '../../lib/math/vec'

export type PassengerKind = 'catOrange' | 'catGrey' | 'catBlack' | 'dog' | 'bunny'

export const PASSENGER_INFO: Readonly<Record<PassengerKind, { readonly name: string }>> = {
  catOrange: { name: 'orange cat' },
  catGrey: { name: 'grey cat' },
  catBlack: { name: 'black and white cat' },
  dog: { name: 'puppy' },
  bunny: { name: 'bunny' },
}

export const PASSENGER_KINDS = Object.keys(PASSENGER_INFO) as readonly PassengerKind[]

export interface Passenger {
  readonly id: number
  readonly kind: PassengerKind
  readonly x: number
  readonly size: number
  /** -1 while waiting at the stop, otherwise seconds into the hop-on animation. */
  readonly boardingSec: number
}

export interface BusState {
  readonly busX: number
  readonly passengers: readonly Passenger[]
  /** Passengers aboard in the current run to ten. */
  readonly aboard: number
  readonly total: number
  readonly spawnInSec: number
  /** > 0 while the full bus drives away. */
  readonly departingSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
}

export interface BusConfig {
  readonly passengerIntervalSec: number
  readonly busWidth: number
}

export interface BusInput {
  readonly targetX: number | null
  readonly width: number
  readonly height: number
  readonly config?: BusConfig
}

export interface BusEvents {
  readonly boarded: readonly { readonly count: number; readonly kind: PassengerKind }[]
  readonly departed: boolean
}

export const COUNT_TARGET = 10
export const BUS_BASE_WIDTH = 300
export const PASSENGER_SIZE = 110
export const ROAD_HEIGHT = 70
export const MAX_WAITING = 3
export const BOARD_SEC = 0.55
export const DEPART_SEC = 2.6
const DEPART_SPEED = 520
const FOLLOW = 0.2
const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8']

export const DEFAULT_BUS_CONFIG: BusConfig = { passengerIntervalSec: 2, busWidth: BUS_BASE_WIDTH }

export const configFromSettings = (settings: BusDriverSettings): BusConfig => ({
  passengerIntervalSec: settings.passengerIntervalSec,
  busWidth: BUS_BASE_WIDTH * settings.busSize,
})

export const createBusState = (width: number): BusState => ({
  busX: width / 2,
  passengers: [],
  aboard: 0,
  total: 0,
  spawnInSec: 0.8,
  departingSec: 0,
  particles: [],
  nextId: 1,
})

/** Bottom of the road, where wheels touch. */
export const roadY = (height: number): number => height - 24
/** Where passengers stand (the pavement is just above the road). */
export const pavementY = (height: number): number => roadY(height) - ROAD_HEIGHT - 6

const spacedX = (width: number, existing: readonly Passenger[], size: number, rng: Rng): number => {
  const candidates = Array.from({ length: 8 }, () => randomBetween(size, Math.max(size, width - size), rng))
  const gap = (x: number) => (existing.length === 0 ? Infinity : Math.min(...existing.map((p) => Math.abs(p.x - x))))
  return candidates.sort((a, b) => gap(b) - gap(a))[0]
}

export const spawnPassenger = (width: number, existing: readonly Passenger[], id: number, rng: Rng): Passenger => ({
  id,
  kind: pickOne(PASSENGER_KINDS, rng),
  x: spacedX(width, existing, PASSENGER_SIZE, rng),
  size: PASSENGER_SIZE,
  boardingSec: -1,
})

/** 0..1 progress of the hop-on animation, 0 while waiting. */
export const boardingProgress = (p: Passenger): number => (p.boardingSec < 0 ? 0 : Math.min(1, p.boardingSec / BOARD_SEC))

export const stepBus = (
  state: BusState,
  dtSec: number,
  input: BusInput,
  rng: Rng = Math.random,
): { readonly state: BusState; readonly events: BusEvents } => {
  const config = input.config ?? DEFAULT_BUS_CONFIG

  if (state.departingSec > 0) {
    const departingSec = Math.max(0, state.departingSec - dtSec)
    const busX = departingSec === 0 ? input.width / 2 : state.busX + DEPART_SPEED * dtSec
    return {
      state: { ...state, busX, departingSec, particles: stepParticles(state.particles, dtSec) },
      events: { boarded: [], departed: false },
    }
  }

  const busX = lerp(state.busX, input.targetX ?? input.width / 2, FOLLOW)
  const doorReach = config.busWidth * 0.32
  const boarded: { count: number; kind: PassengerKind }[] = []
  let aboard = state.aboard
  let departed = false

  const passengers = state.passengers
    .map((p) => {
      if (p.boardingSec >= 0) return { ...p, boardingSec: p.boardingSec + dtSec }
      if (Math.abs(p.x - busX) <= doorReach) {
        aboard += 1
        boarded.push({ count: aboard, kind: p.kind })
        if (aboard >= COUNT_TARGET) {
          departed = true
          aboard = 0
        }
        return { ...p, boardingSec: 0 }
      }
      return p
    })
    .filter((p) => p.boardingSec < BOARD_SEC)

  const sparkles = boarded.flatMap(() =>
    spawnBurst({ x: busX, y: pavementY(input.height) }, { count: 10, colors: ['#ffd60a', '#ffffff'], speed: [60, 200], size: [4, 8], gravity: 200 }, rng),
  )
  const confetti = departed
    ? spawnBurst({ x: busX, y: pavementY(input.height) - 80 }, { count: 110, colors: CONFETTI, speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 }, rng)
    : []

  let spawnInSec = state.spawnInSec - dtSec
  let nextPassengers = passengers
  let nextId = state.nextId
  const waiting = passengers.filter((p) => p.boardingSec < 0)
  if (!departed && spawnInSec <= 0 && waiting.length < MAX_WAITING && input.width > 0) {
    nextPassengers = [...passengers, spawnPassenger(input.width, waiting, nextId, rng)]
    nextId += 1
    spawnInSec = config.passengerIntervalSec
  }

  return {
    state: {
      busX,
      passengers: departed ? [] : nextPassengers,
      aboard,
      total: state.total + boarded.length,
      spawnInSec,
      departingSec: departed ? DEPART_SEC : 0,
      particles: [...stepParticles(state.particles, dtSec), ...sparkles, ...confetti],
      nextId,
    },
    events: { boarded, departed },
  }
}
