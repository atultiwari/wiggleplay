import { SESSION } from '../../config/site'
import { clamp } from '../math/vec'
import { INTERACTION_MODE_IDS, type InteractionMode } from '../tracking/modes'

export type CameraQuality = 'low' | 'medium' | 'high'
export type HandsTracked = 'auto' | 1 | 2
export type SliceTolerance = 'fine' | 'normal' | 'generous'

export interface GlobalSettings {
  /** How the child interacts: whole body, a hand, a fingertip or the head. */
  readonly interaction: InteractionMode
  /** Master multiplier for sound effects, 0..3 (300 %). */
  readonly effectsVolume: number
  readonly voiceEnabled: boolean
  /** 0..1 — speech synthesis cannot go louder than 1. */
  readonly voiceVolume: number
  /** 0 = very smooth but laggy, 1 = raw and snappy. */
  readonly responsiveness: number
  readonly cameraQuality: CameraQuality
  readonly handsTracked: HandsTracked
  readonly showHandCursor: boolean
  /** How visible the child is behind the game, 0..1. */
  readonly cameraVisibility: number
  readonly sessionMinutes: number
  readonly showFps: boolean
}

export interface WavePopSettings {
  readonly maxBubbles: number
  readonly spawnIntervalSec: number
  readonly bubbleSize: number
  readonly riseSpeed: number
}

export interface FruitSliceSettings {
  readonly maxFruits: number
  readonly spawnIntervalSec: number
  readonly speed: number
  readonly fruitSize: number
  readonly tolerance: SliceTolerance
}

export interface CatchStarsSettings {
  readonly fallSpeed: number
  readonly spawnIntervalSec: number
  readonly basketWidth: number
  readonly starSize: number
}

export interface AirPaintSettings {
  readonly brushSize: number
  readonly dwellMs: number
  readonly fistLifts: boolean
}

export interface CatTickleSettings {
  readonly maxCats: number
  readonly appearIntervalSec: number
  readonly catSize: number
  readonly stayForSec: number
}

export interface FlyHighSettings {
  readonly balloonIntervalSec: number
  readonly speed: number
  readonly planeSize: number
}

export interface BusDriverSettings {
  readonly passengerIntervalSec: number
  readonly busSize: number
}

export interface BeepMeowSettings {
  readonly maxThings: number
  readonly speed: number
  readonly thingSize: number
  readonly askQuestions: boolean
}

export interface WiggleMirrorSettings {
  readonly puppetSize: number
  readonly reactions: boolean
  readonly showSkeleton: boolean
}

export interface ToyTownSettings {
  readonly propSize: number
  readonly speed: number
  readonly prompts: boolean
  readonly showCursor: boolean
}

export interface SimonSaysSettings {
  readonly gapSec: number
  readonly harderMoves: boolean
  readonly showSkeleton: boolean
}

export interface TapFarmSettings {
  readonly animalCount: number
  readonly askQuestions: boolean
  readonly animalSize: number
}

export interface AnimalCallSettings {
  /** 0..1: how loud the child must be. Lower is easier. */
  readonly loudness: number
  readonly showMeter: boolean
}

export interface ShakeTreeSettings {
  readonly appleCount: number
  /** 0..1: how hard the tablet must be shaken. Lower is easier. */
  readonly shakeStrength: number
}

export type LetterOrder = 'abc' | 'random'
export const LETTER_ORDERS: readonly LetterOrder[] = ['abc', 'random']

export interface AlphabetTrailSettings {
  readonly gemSize: number
  readonly order: LetterOrder
  readonly sayWords: boolean
}

export interface PathTracerSettings {
  readonly gemSize: number
  readonly harderShapes: boolean
}

export interface Settings {
  readonly global: GlobalSettings
  readonly wavePop: WavePopSettings
  readonly fruitSlice: FruitSliceSettings
  readonly catchStars: CatchStarsSettings
  readonly airPaint: AirPaintSettings
  readonly catTickle: CatTickleSettings
  readonly flyHigh: FlyHighSettings
  readonly busDriver: BusDriverSettings
  readonly beepMeow: BeepMeowSettings
  readonly wiggleMirror: WiggleMirrorSettings
  readonly toyTown: ToyTownSettings
  readonly simonSays: SimonSaysSettings
  readonly tapFarm: TapFarmSettings
  readonly animalCall: AnimalCallSettings
  readonly shakeTree: ShakeTreeSettings
  readonly alphabetTrail: AlphabetTrailSettings
  readonly pathTracer: PathTracerSettings
}

export type GameSettingsKey = Exclude<keyof Settings, 'global'>

export interface NumberRange {
  readonly min: number
  readonly max: number
  readonly step: number
}

export const CAMERA_QUALITIES: readonly CameraQuality[] = ['low', 'medium', 'high']
export const HANDS_OPTIONS: readonly HandsTracked[] = ['auto', 1, 2]
export const SLICE_TOLERANCES: readonly SliceTolerance[] = ['fine', 'normal', 'generous']

export const GLOBAL_RANGES = {
  effectsVolume: { min: 0, max: 3, step: 0.1 },
  voiceVolume: { min: 0, max: 1, step: 0.05 },
  responsiveness: { min: 0, max: 1, step: 0.05 },
  cameraVisibility: { min: 0, max: 1, step: 0.05 },
  sessionMinutes: { min: 2, max: 20, step: 1 },
} as const satisfies Record<string, NumberRange>

export const WAVE_POP_RANGES = {
  maxBubbles: { min: 1, max: 20, step: 1 },
  spawnIntervalSec: { min: 0.2, max: 4, step: 0.1 },
  bubbleSize: { min: 0.5, max: 2, step: 0.1 },
  riseSpeed: { min: 0.3, max: 3, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const FRUIT_SLICE_RANGES = {
  maxFruits: { min: 1, max: 10, step: 1 },
  spawnIntervalSec: { min: 0.3, max: 5, step: 0.1 },
  speed: { min: 0.5, max: 2, step: 0.1 },
  fruitSize: { min: 0.5, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const CATCH_STARS_RANGES = {
  fallSpeed: { min: 0.3, max: 3, step: 0.1 },
  spawnIntervalSec: { min: 0.3, max: 5, step: 0.1 },
  basketWidth: { min: 0.5, max: 2.5, step: 0.1 },
  starSize: { min: 0.5, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const AIR_PAINT_RANGES = {
  brushSize: { min: 6, max: 70, step: 2 },
  dwellMs: { min: 300, max: 2500, step: 100 },
} as const satisfies Record<string, NumberRange>

export const CAT_TICKLE_RANGES = {
  maxCats: { min: 1, max: 8, step: 1 },
  appearIntervalSec: { min: 0.5, max: 5, step: 0.1 },
  catSize: { min: 0.5, max: 2, step: 0.1 },
  stayForSec: { min: 1, max: 10, step: 0.5 },
} as const satisfies Record<string, NumberRange>

export const FLY_HIGH_RANGES = {
  balloonIntervalSec: { min: 0.3, max: 4, step: 0.1 },
  speed: { min: 0.3, max: 3, step: 0.1 },
  planeSize: { min: 0.5, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const BUS_DRIVER_RANGES = {
  passengerIntervalSec: { min: 0.5, max: 6, step: 0.1 },
  busSize: { min: 0.6, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const WIGGLE_MIRROR_RANGES = {
  puppetSize: { min: 0.6, max: 1.6, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const TOY_TOWN_RANGES = {
  propSize: { min: 0.6, max: 1.6, step: 0.1 },
  speed: { min: 0.3, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const SIMON_SAYS_RANGES = {
  gapSec: { min: 2, max: 8, step: 0.5 },
} as const satisfies Record<string, NumberRange>

export const TAP_FARM_RANGES = {
  animalCount: { min: 2, max: 6, step: 1 },
  animalSize: { min: 0.7, max: 1.5, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const ANIMAL_CALL_RANGES = {
  loudness: { min: 0.1, max: 0.9, step: 0.05 },
} as const satisfies Record<string, NumberRange>

export const SHAKE_TREE_RANGES = {
  appleCount: { min: 3, max: 10, step: 1 },
  shakeStrength: { min: 0.1, max: 1, step: 0.05 },
} as const satisfies Record<string, NumberRange>

export const TRACE_RANGES = {
  gemSize: { min: 0.7, max: 1.6, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const BEEP_MEOW_RANGES = {
  maxThings: { min: 1, max: 10, step: 1 },
  speed: { min: 0.3, max: 3, step: 0.1 },
  thingSize: { min: 0.5, max: 2, step: 0.1 },
} as const satisfies Record<string, NumberRange>

export const DEFAULT_SETTINGS: Settings = {
  global: {
    interaction: 'body',
    effectsVolume: 2,
    voiceEnabled: true,
    voiceVolume: 1,
    responsiveness: 0.65,
    cameraQuality: 'medium',
    handsTracked: 'auto',
    showHandCursor: true,
    cameraVisibility: 0.5,
    sessionMinutes: SESSION.suggestedMinutes,
    showFps: false,
  },
  wavePop: { maxBubbles: 7, spawnIntervalSec: 0.9, bubbleSize: 1, riseSpeed: 1 },
  fruitSlice: { maxFruits: 4, spawnIntervalSec: 1.5, speed: 1, fruitSize: 1, tolerance: 'normal' },
  catchStars: { fallSpeed: 1, spawnIntervalSec: 1.5, basketWidth: 1, starSize: 1 },
  airPaint: { brushSize: 22, dwellMs: 700, fistLifts: true },
  catTickle: { maxCats: 3, appearIntervalSec: 1.5, catSize: 1, stayForSec: 4 },
  flyHigh: { balloonIntervalSec: 1.4, speed: 1, planeSize: 1 },
  busDriver: { passengerIntervalSec: 2, busSize: 1 },
  beepMeow: { maxThings: 5, speed: 1, thingSize: 1, askQuestions: true },
  wiggleMirror: { puppetSize: 1, reactions: true, showSkeleton: false },
  toyTown: { propSize: 1, speed: 1, prompts: true, showCursor: true },
  simonSays: { gapSec: 4, harderMoves: false, showSkeleton: false },
  tapFarm: { animalCount: 4, askQuestions: true, animalSize: 1 },
  animalCall: { loudness: 0.35, showMeter: true },
  shakeTree: { appleCount: 5, shakeStrength: 0.4 },
  alphabetTrail: { gemSize: 1, order: 'abc', sayWords: true },
  pathTracer: { gemSize: 1, harderShapes: false },
}

/** Maps a game id from the catalogue to its settings slice. */
export const GAME_SETTINGS_KEYS: Readonly<Record<string, GameSettingsKey>> = {
  'wave-pop': 'wavePop',
  'fruit-slice': 'fruitSlice',
  'catch-stars': 'catchStars',
  'air-paint': 'airPaint',
  'cat-tickle': 'catTickle',
  'fly-high': 'flyHigh',
  'bus-driver': 'busDriver',
  'beep-meow-whoosh': 'beepMeow',
  'wiggle-mirror': 'wiggleMirror',
  'toy-town': 'toyTown',
  'simon-says': 'simonSays',
  'tap-farm': 'tapFarm',
  'animal-call': 'animalCall',
  'shake-tree': 'shakeTree',
  'alphabet-trail': 'alphabetTrail',
  'path-tracer': 'pathTracer',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const num = (value: unknown, fallback: number, range: NumberRange): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, range.min, range.max) : fallback

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

const oneOf = <T>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback

const sanitizeGlobal = (raw: unknown): GlobalSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.global
  // Older saves used -1 for "game default"; that now means the 50 % default.
  const visibility =
    typeof r.cameraVisibility === 'number' && r.cameraVisibility < 0
      ? d.cameraVisibility
      : num(r.cameraVisibility, d.cameraVisibility, GLOBAL_RANGES.cameraVisibility)
  return {
    interaction: oneOf(r.interaction, INTERACTION_MODE_IDS, d.interaction),
    effectsVolume: num(r.effectsVolume, d.effectsVolume, GLOBAL_RANGES.effectsVolume),
    voiceEnabled: bool(r.voiceEnabled, d.voiceEnabled),
    voiceVolume: num(r.voiceVolume, d.voiceVolume, GLOBAL_RANGES.voiceVolume),
    responsiveness: num(r.responsiveness, d.responsiveness, GLOBAL_RANGES.responsiveness),
    cameraQuality: oneOf(r.cameraQuality, CAMERA_QUALITIES, d.cameraQuality),
    handsTracked: oneOf(r.handsTracked, HANDS_OPTIONS, d.handsTracked),
    showHandCursor: bool(r.showHandCursor, d.showHandCursor),
    cameraVisibility: visibility,
    sessionMinutes: num(r.sessionMinutes, d.sessionMinutes, GLOBAL_RANGES.sessionMinutes),
    showFps: bool(r.showFps, d.showFps),
  }
}

const sanitizeWavePop = (raw: unknown): WavePopSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.wavePop
  return {
    maxBubbles: Math.round(num(r.maxBubbles, d.maxBubbles, WAVE_POP_RANGES.maxBubbles)),
    spawnIntervalSec: num(r.spawnIntervalSec, d.spawnIntervalSec, WAVE_POP_RANGES.spawnIntervalSec),
    bubbleSize: num(r.bubbleSize, d.bubbleSize, WAVE_POP_RANGES.bubbleSize),
    riseSpeed: num(r.riseSpeed, d.riseSpeed, WAVE_POP_RANGES.riseSpeed),
  }
}

const sanitizeFruitSlice = (raw: unknown): FruitSliceSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.fruitSlice
  return {
    maxFruits: Math.round(num(r.maxFruits, d.maxFruits, FRUIT_SLICE_RANGES.maxFruits)),
    spawnIntervalSec: num(r.spawnIntervalSec, d.spawnIntervalSec, FRUIT_SLICE_RANGES.spawnIntervalSec),
    speed: num(r.speed, d.speed, FRUIT_SLICE_RANGES.speed),
    fruitSize: num(r.fruitSize, d.fruitSize, FRUIT_SLICE_RANGES.fruitSize),
    tolerance: oneOf(r.tolerance, SLICE_TOLERANCES, d.tolerance),
  }
}

const sanitizeCatchStars = (raw: unknown): CatchStarsSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.catchStars
  return {
    fallSpeed: num(r.fallSpeed, d.fallSpeed, CATCH_STARS_RANGES.fallSpeed),
    spawnIntervalSec: num(r.spawnIntervalSec, d.spawnIntervalSec, CATCH_STARS_RANGES.spawnIntervalSec),
    basketWidth: num(r.basketWidth, d.basketWidth, CATCH_STARS_RANGES.basketWidth),
    starSize: num(r.starSize, d.starSize, CATCH_STARS_RANGES.starSize),
  }
}

const sanitizeAirPaint = (raw: unknown): AirPaintSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.airPaint
  return {
    brushSize: num(r.brushSize, d.brushSize, AIR_PAINT_RANGES.brushSize),
    dwellMs: num(r.dwellMs, d.dwellMs, AIR_PAINT_RANGES.dwellMs),
    fistLifts: bool(r.fistLifts, d.fistLifts),
  }
}

const sanitizeCatTickle = (raw: unknown): CatTickleSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.catTickle
  return {
    maxCats: Math.round(num(r.maxCats, d.maxCats, CAT_TICKLE_RANGES.maxCats)),
    appearIntervalSec: num(r.appearIntervalSec, d.appearIntervalSec, CAT_TICKLE_RANGES.appearIntervalSec),
    catSize: num(r.catSize, d.catSize, CAT_TICKLE_RANGES.catSize),
    stayForSec: num(r.stayForSec, d.stayForSec, CAT_TICKLE_RANGES.stayForSec),
  }
}

const sanitizeFlyHigh = (raw: unknown): FlyHighSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.flyHigh
  return {
    balloonIntervalSec: num(r.balloonIntervalSec, d.balloonIntervalSec, FLY_HIGH_RANGES.balloonIntervalSec),
    speed: num(r.speed, d.speed, FLY_HIGH_RANGES.speed),
    planeSize: num(r.planeSize, d.planeSize, FLY_HIGH_RANGES.planeSize),
  }
}

const sanitizeBusDriver = (raw: unknown): BusDriverSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.busDriver
  return {
    passengerIntervalSec: num(r.passengerIntervalSec, d.passengerIntervalSec, BUS_DRIVER_RANGES.passengerIntervalSec),
    busSize: num(r.busSize, d.busSize, BUS_DRIVER_RANGES.busSize),
  }
}

const sanitizeBeepMeow = (raw: unknown): BeepMeowSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.beepMeow
  return {
    maxThings: Math.round(num(r.maxThings, d.maxThings, BEEP_MEOW_RANGES.maxThings)),
    speed: num(r.speed, d.speed, BEEP_MEOW_RANGES.speed),
    thingSize: num(r.thingSize, d.thingSize, BEEP_MEOW_RANGES.thingSize),
    askQuestions: bool(r.askQuestions, d.askQuestions),
  }
}

const sanitizeWiggleMirror = (raw: unknown): WiggleMirrorSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.wiggleMirror
  return {
    puppetSize: num(r.puppetSize, d.puppetSize, WIGGLE_MIRROR_RANGES.puppetSize),
    reactions: bool(r.reactions, d.reactions),
    showSkeleton: bool(r.showSkeleton, d.showSkeleton),
  }
}

const sanitizeToyTown = (raw: unknown): ToyTownSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.toyTown
  return {
    propSize: num(r.propSize, d.propSize, TOY_TOWN_RANGES.propSize),
    speed: num(r.speed, d.speed, TOY_TOWN_RANGES.speed),
    prompts: bool(r.prompts, d.prompts),
    showCursor: bool(r.showCursor, d.showCursor),
  }
}

const sanitizeSimonSays = (raw: unknown): SimonSaysSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.simonSays
  return {
    gapSec: num(r.gapSec, d.gapSec, SIMON_SAYS_RANGES.gapSec),
    harderMoves: bool(r.harderMoves, d.harderMoves),
    showSkeleton: bool(r.showSkeleton, d.showSkeleton),
  }
}

const sanitizeTapFarm = (raw: unknown): TapFarmSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.tapFarm
  return {
    animalCount: Math.round(num(r.animalCount, d.animalCount, TAP_FARM_RANGES.animalCount)),
    askQuestions: bool(r.askQuestions, d.askQuestions),
    animalSize: num(r.animalSize, d.animalSize, TAP_FARM_RANGES.animalSize),
  }
}

const sanitizeAnimalCall = (raw: unknown): AnimalCallSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.animalCall
  return {
    loudness: num(r.loudness, d.loudness, ANIMAL_CALL_RANGES.loudness),
    showMeter: bool(r.showMeter, d.showMeter),
  }
}

const sanitizeShakeTree = (raw: unknown): ShakeTreeSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.shakeTree
  return {
    appleCount: Math.round(num(r.appleCount, d.appleCount, SHAKE_TREE_RANGES.appleCount)),
    shakeStrength: num(r.shakeStrength, d.shakeStrength, SHAKE_TREE_RANGES.shakeStrength),
  }
}

const sanitizeAlphabetTrail = (raw: unknown): AlphabetTrailSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.alphabetTrail
  return {
    gemSize: num(r.gemSize, d.gemSize, TRACE_RANGES.gemSize),
    order: LETTER_ORDERS.includes(r.order as LetterOrder) ? (r.order as LetterOrder) : d.order,
    sayWords: bool(r.sayWords, d.sayWords),
  }
}

const sanitizePathTracer = (raw: unknown): PathTracerSettings => {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.pathTracer
  return {
    gemSize: num(r.gemSize, d.gemSize, TRACE_RANGES.gemSize),
    harderShapes: bool(r.harderShapes, d.harderShapes),
  }
}

/** Never trust stored data: every field is validated and clamped, unknown fields are dropped. */
export const sanitizeSettings = (raw: unknown): Settings => {
  const r = isRecord(raw) ? raw : {}
  return {
    global: sanitizeGlobal(r.global),
    wavePop: sanitizeWavePop(r.wavePop),
    fruitSlice: sanitizeFruitSlice(r.fruitSlice),
    catchStars: sanitizeCatchStars(r.catchStars),
    airPaint: sanitizeAirPaint(r.airPaint),
    catTickle: sanitizeCatTickle(r.catTickle),
    flyHigh: sanitizeFlyHigh(r.flyHigh),
    busDriver: sanitizeBusDriver(r.busDriver),
    beepMeow: sanitizeBeepMeow(r.beepMeow),
    wiggleMirror: sanitizeWiggleMirror(r.wiggleMirror),
    toyTown: sanitizeToyTown(r.toyTown),
    simonSays: sanitizeSimonSays(r.simonSays),
    tapFarm: sanitizeTapFarm(r.tapFarm),
    animalCall: sanitizeAnimalCall(r.animalCall),
    shakeTree: sanitizeShakeTree(r.shakeTree),
    alphabetTrail: sanitizeAlphabetTrail(r.alphabetTrail),
    pathTracer: sanitizePathTracer(r.pathTracer),
  }
}
