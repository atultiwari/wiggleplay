import type { AnimalCallSettings } from '../../lib/settings/schema'

export type CallAnimal = 'cow' | 'sheep' | 'duck' | 'pig' | 'cat' | 'dog'
export const CALL_ANIMALS: readonly CallAnimal[] = ['cow', 'sheep', 'duck', 'pig', 'cat', 'dog']

export interface CallInfo {
  readonly name: string
  readonly sound: string
  readonly ask: string
}

export const CALL_INFO: Readonly<Record<CallAnimal, CallInfo>> = {
  cow: { name: 'cow', sound: 'Moo!', ask: 'What does the cow say? Moo! Can you moo?' },
  sheep: { name: 'sheep', sound: 'Baa!', ask: 'What does the sheep say? Baa! Can you baa?' },
  duck: { name: 'duck', sound: 'Quack!', ask: 'What does the duck say? Quack! Can you quack?' },
  pig: { name: 'pig', sound: 'Oink!', ask: 'What does the pig say? Oink oink! Can you oink?' },
  cat: { name: 'cat', sound: 'Meow!', ask: 'What does the cat say? Meow! Can you meow?' },
  dog: { name: 'dog', sound: 'Woof!', ask: 'What does the dog say? Woof woof! Can you woof?' },
}

export type CallPhase = 'asking' | 'listening' | 'dancing'

export interface CallState {
  readonly animalIndex: number
  readonly phase: CallPhase
  readonly phaseSec: number
  /** How long the child has been loud enough, in seconds. */
  readonly loudSec: number
  /** Calls answered for the current animal. */
  readonly answered: number
  readonly total: number
  readonly time: number
}

export interface CallConfig {
  readonly loudness: number
}

export interface CallInput {
  readonly level: number
  readonly config?: CallConfig
}

export interface CallEvents {
  readonly asked: CallAnimal | null
  readonly answered: CallAnimal | null
  readonly nextAnimal: CallAnimal | null
  readonly nudge: boolean
}

export const ASK_SEC = 3.2
export const HOLD_SEC = 0.25
export const DANCE_SEC = 2.4
export const NUDGE_SEC = 9
export const CALLS_PER_ANIMAL = 2

export const DEFAULT_CALL_CONFIG: CallConfig = { loudness: 0.35 }

export const configFromSettings = (settings: AnimalCallSettings): CallConfig => ({ loudness: settings.loudness })

export const createCallState = (): CallState => ({ animalIndex: 0, phase: 'asking', phaseSec: 0, loudSec: 0, answered: 0, total: 0, time: 0 })

export const currentAnimal = (state: CallState): CallAnimal => CALL_ANIMALS[state.animalIndex % CALL_ANIMALS.length]

/** 0..1 progress of the child's sound toward triggering the dance. */
export const callProgress = (state: CallState): number => Math.min(1, state.loudSec / HOLD_SEC)

export const stepCall = (state: CallState, dtSec: number, input: CallInput): { readonly state: CallState; readonly events: CallEvents } => {
  const config = input.config ?? DEFAULT_CALL_CONFIG
  const phaseSec = state.phaseSec + dtSec
  const time = state.time + dtSec
  const none: CallEvents = { asked: null, answered: null, nextAnimal: null, nudge: false }
  const animal = currentAnimal(state)

  if (state.phase === 'asking') {
    // The first frame of the asking phase fires the question; the phase gives the voice time to finish.
    if (state.phaseSec === 0) return { state: { ...state, phaseSec, time }, events: { ...none, asked: animal } }
    if (phaseSec >= ASK_SEC) return { state: { ...state, phase: 'listening', phaseSec: 0, loudSec: 0, time }, events: none }
    return { state: { ...state, phaseSec, time }, events: none }
  }

  if (state.phase === 'listening') {
    const loud = input.level >= config.loudness
    const loudSec = loud ? state.loudSec + dtSec : Math.max(0, state.loudSec - dtSec * 2)
    if (loudSec >= HOLD_SEC) {
      return {
        state: { ...state, phase: 'dancing', phaseSec: 0, loudSec: 0, answered: state.answered + 1, total: state.total + 1, time },
        events: { ...none, answered: animal },
      }
    }
    const nudge = phaseSec >= NUDGE_SEC
    return { state: { ...state, phaseSec: nudge ? 0 : phaseSec, loudSec, time }, events: { ...none, nudge } }
  }

  if (phaseSec >= DANCE_SEC) {
    if (state.answered >= CALLS_PER_ANIMAL) {
      const next: CallState = { ...state, animalIndex: state.animalIndex + 1, phase: 'asking', phaseSec: 0, loudSec: 0, answered: 0, time }
      return { state: next, events: { ...none, nextAnimal: currentAnimal(next) } }
    }
    return { state: { ...state, phase: 'listening', phaseSec: 0, loudSec: 0, time }, events: none }
  }
  return { state: { ...state, phaseSec, time }, events: none }
}
