import type { Point } from '../../lib/math/vec'
import { distance } from '../../lib/math/vec'
import { pickOne, type Rng } from '../../lib/game/random'
import type { TapFarmSettings } from '../../lib/settings/schema'

export type AnimalKind = 'cow' | 'pig' | 'sheep' | 'chicken' | 'duck' | 'horse'
export const ANIMAL_KINDS: readonly AnimalKind[] = ['cow', 'pig', 'sheep', 'chicken', 'duck', 'horse']

export interface AnimalInfo {
  readonly name: string
  readonly sound: string
  readonly emoji: string
}

export const ANIMAL_INFO: Readonly<Record<AnimalKind, AnimalInfo>> = {
  cow: { name: 'cow', sound: 'Moo!', emoji: '🐄' },
  pig: { name: 'pig', sound: 'Oink oink!', emoji: '🐷' },
  sheep: { name: 'sheep', sound: 'Baa!', emoji: '🐑' },
  chicken: { name: 'chicken', sound: 'Cluck cluck!', emoji: '🐔' },
  duck: { name: 'duck', sound: 'Quack!', emoji: '🦆' },
  horse: { name: 'horse', sound: 'Neigh!', emoji: '🐴' },
}

export interface Animal {
  readonly kind: AnimalKind
  /** Home position as a fraction of the stage (0..1). */
  readonly u: number
  readonly v: number
  /** Seconds of happy-bounce animation left. */
  readonly happySec: number
  readonly taps: number
}

export interface FarmState {
  readonly animals: readonly Animal[]
  readonly time: number
  readonly prompt: AnimalKind | null
  readonly promptInSec: number
  readonly promptRemainingSec: number
  readonly found: number
}

export interface FarmConfig {
  readonly animalCount: number
  readonly askQuestions: boolean
  readonly animalSize: number
}

export interface FarmInput {
  readonly taps: readonly Point[]
  readonly width: number
  readonly height: number
  readonly config?: FarmConfig
}

export interface FarmEvents {
  readonly tapped: readonly AnimalKind[]
  readonly promptAsked: AnimalKind | null
  readonly promptSolved: AnimalKind | null
  readonly promptMissed: AnimalKind | null
}

export const HAPPY_SEC = 1.1
export const FIRST_PROMPT_SEC = 6
export const PROMPT_GAP_SEC = 7
export const PROMPT_TIMEOUT_SEC = 10
export const BASE_SIZE = 0.26
/** Tap radius as a fraction of the drawn size: a near miss still counts. */
export const HIT_SCALE = 0.7

export const DEFAULT_FARM_CONFIG: FarmConfig = { animalCount: 4, askQuestions: true, animalSize: 1 }

export const configFromSettings = (settings: TapFarmSettings): FarmConfig => ({
  animalCount: settings.animalCount,
  askQuestions: settings.askQuestions,
  animalSize: settings.animalSize,
})

/** Home spots laid out so the animals never overlap, whatever the count. */
const SPOTS: readonly (readonly [number, number])[] = [
  [0.18, 0.48],
  [0.5, 0.46],
  [0.82, 0.48],
  [0.25, 0.8],
  [0.75, 0.8],
  [0.5, 0.82],
]

export const createFarmState = (config: FarmConfig = DEFAULT_FARM_CONFIG): FarmState => ({
  animals: ANIMAL_KINDS.slice(0, Math.max(1, Math.min(ANIMAL_KINDS.length, config.animalCount))).map((kind, i) => ({
    kind,
    u: SPOTS[i][0],
    v: SPOTS[i][1],
    happySec: 0,
    taps: 0,
  })),
  time: 0,
  prompt: null,
  promptInSec: FIRST_PROMPT_SEC,
  promptRemainingSec: 0,
  found: 0,
})

/** Drawn size in pixels for the current stage. */
export const animalSize = (width: number, height: number, config: FarmConfig): number => Math.min(width, height) * BASE_SIZE * config.animalSize

export const animalCentre = (animal: Animal, width: number, height: number): Point => ({ x: animal.u * width, y: animal.v * height })

/** Little idle bob so the farm never looks frozen; a bigger bounce while happy. */
export const animalBounce = (animal: Animal, time: number): number =>
  Math.sin(time * 2 + animal.u * 9) * 0.02 + (animal.happySec > 0 ? Math.sin((animal.happySec / HAPPY_SEC) * Math.PI) * 0.18 : 0)

export const animalAt = (animals: readonly Animal[], point: Point, width: number, height: number, config: FarmConfig): Animal | undefined => {
  const radius = animalSize(width, height, config) * HIT_SCALE
  return animals.find((animal) => distance(animalCentre(animal, width, height), point) <= radius)
}

export const stepFarm = (state: FarmState, dtSec: number, input: FarmInput, rng: Rng = Math.random): { readonly state: FarmState; readonly events: FarmEvents } => {
  const config = input.config ?? DEFAULT_FARM_CONFIG
  const tapped = input.taps
    .map((tap) => animalAt(state.animals, tap, input.width, input.height, config)?.kind)
    .filter((kind): kind is AnimalKind => kind !== undefined)
  const animals = state.animals.map((animal) => ({
    ...animal,
    happySec: tapped.includes(animal.kind) ? HAPPY_SEC : Math.max(0, animal.happySec - dtSec),
    taps: animal.taps + tapped.filter((kind) => kind === animal.kind).length,
  }))

  let prompt = state.prompt
  let promptInSec = state.promptInSec
  let promptRemainingSec = state.promptRemainingSec
  let found = state.found
  let promptAsked: AnimalKind | null = null
  let promptSolved: AnimalKind | null = null
  let promptMissed: AnimalKind | null = null
  if (!config.askQuestions) {
    prompt = null
  } else if (prompt) {
    if (tapped.includes(prompt)) {
      promptSolved = prompt
      found += 1
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
    if (promptInSec <= 0 && animals.length > 0) {
      const candidates = animals.filter((animal) => animal.kind !== state.prompt)
      prompt = pickOne(candidates.length > 0 ? candidates : animals, rng).kind
      promptRemainingSec = PROMPT_TIMEOUT_SEC
      promptAsked = prompt
    }
  }

  return {
    state: { animals, time: state.time + dtSec, prompt, promptInSec, promptRemainingSec, found },
    events: { tapped, promptAsked, promptSolved, promptMissed },
  }
}
