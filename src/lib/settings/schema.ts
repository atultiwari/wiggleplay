import { SESSION } from '../../config/site'
import { clamp } from '../math/vec'

export type CameraQuality = 'low' | 'medium' | 'high'
export type HandsTracked = 'auto' | 1 | 2
export type SliceTolerance = 'fine' | 'normal' | 'generous'

export interface GlobalSettings {
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
  /** -1 keeps each game's own default, otherwise 0..1. */
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

export interface Settings {
  readonly global: GlobalSettings
  readonly wavePop: WavePopSettings
  readonly fruitSlice: FruitSliceSettings
  readonly catchStars: CatchStarsSettings
  readonly airPaint: AirPaintSettings
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

export const DEFAULT_SETTINGS: Settings = {
  global: {
    effectsVolume: 2,
    voiceEnabled: true,
    voiceVolume: 1,
    responsiveness: 0.65,
    cameraQuality: 'medium',
    handsTracked: 'auto',
    showHandCursor: true,
    cameraVisibility: -1,
    sessionMinutes: SESSION.suggestedMinutes,
    showFps: false,
  },
  wavePop: { maxBubbles: 7, spawnIntervalSec: 0.9, bubbleSize: 1, riseSpeed: 1 },
  fruitSlice: { maxFruits: 4, spawnIntervalSec: 1.5, speed: 1, fruitSize: 1, tolerance: 'normal' },
  catchStars: { fallSpeed: 1, spawnIntervalSec: 1.5, basketWidth: 1, starSize: 1 },
  airPaint: { brushSize: 22, dwellMs: 700, fistLifts: true },
}

/** Maps a game id from the catalogue to its settings slice. */
export const GAME_SETTINGS_KEYS: Readonly<Record<string, GameSettingsKey>> = {
  'wave-pop': 'wavePop',
  'fruit-slice': 'fruitSlice',
  'catch-stars': 'catchStars',
  'air-paint': 'airPaint',
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
  const visibility =
    r.cameraVisibility === -1 ? -1 : num(r.cameraVisibility, d.cameraVisibility, GLOBAL_RANGES.cameraVisibility)
  return {
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

/** Never trust stored data: every field is validated and clamped, unknown fields are dropped. */
export const sanitizeSettings = (raw: unknown): Settings => {
  const r = isRecord(raw) ? raw : {}
  return {
    global: sanitizeGlobal(r.global),
    wavePop: sanitizeWavePop(r.wavePop),
    fruitSlice: sanitizeFruitSlice(r.fruitSlice),
    catchStars: sanitizeCatchStars(r.catchStars),
    airPaint: sanitizeAirPaint(r.airPaint),
  }
}
