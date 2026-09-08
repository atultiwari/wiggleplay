import type { Pointer } from '../../types/pointer'
import { circleContainsPoint } from '../../lib/game/collision'
import { spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { pickOne, randomBetween, type Rng } from '../../lib/game/random'
import type { CatTickleSettings } from '../../lib/settings/schema'
import { distance } from '../../lib/math/vec'

export type CatKind = 'orange' | 'grey' | 'black'
export type CatPhase = 'appearing' | 'waiting' | 'happy' | 'leaving'

export interface CatInfo {
  readonly name: string
  readonly art: 'catOrange' | 'catGrey' | 'catBlack'
}

export const CAT_INFO: Readonly<Record<CatKind, CatInfo>> = {
  orange: { name: 'Orange cat', art: 'catOrange' },
  grey: { name: 'Grey cat', art: 'catGrey' },
  black: { name: 'Black and white cat', art: 'catBlack' },
}

export const CAT_KINDS = Object.keys(CAT_INFO) as readonly CatKind[]

export interface Cat {
  readonly id: number
  readonly kind: CatKind
  readonly x: number
  readonly y: number
  readonly size: number
  readonly phase: CatPhase
  readonly phaseSec: number
}

export interface CatState {
  readonly cats: readonly Cat[]
  readonly tickled: number
  readonly spawnInSec: number
  readonly particles: readonly Particle[]
  readonly nextId: number
}

export interface CatConfig {
  readonly maxCats: number
  readonly appearIntervalSec: number
  readonly sizeScale: number
  readonly stayForSec: number
  readonly hitMarginPx: number
}

export interface CatInput {
  readonly pointers: readonly Pointer[]
  readonly width: number
  readonly height: number
  readonly config?: CatConfig
}

export interface CatEvents {
  readonly tickled: readonly Cat[]
  readonly milestone: boolean
}

export const CAT_BASE_SIZE = 170
export const APPEAR_SEC = 0.35
export const HAPPY_SEC = 1.1
export const LEAVE_SEC = 0.35
export const MILESTONE_EVERY = 5
/** Keep cats out from under the top bar. */
const TOP_MARGIN = 110
const HEART_COLORS = ['#ff4d6d', '#ff70b8', '#ffffff']

export const DEFAULT_CAT_CONFIG: CatConfig = {
  maxCats: 3,
  appearIntervalSec: 1.5,
  sizeScale: 1,
  stayForSec: 4,
  hitMarginPx: 24,
}

export const configFromSettings = (settings: CatTickleSettings): CatConfig => ({
  maxCats: settings.maxCats,
  appearIntervalSec: settings.appearIntervalSec,
  sizeScale: settings.catSize,
  stayForSec: settings.stayForSec,
  hitMarginPx: DEFAULT_CAT_CONFIG.hitMarginPx,
})

export const createCatState = (): CatState => ({ cats: [], tickled: 0, spawnInSec: 0.5, particles: [], nextId: 1 })

/** Picks a spot away from the other cats. */
export const spawnCat = (
  width: number,
  height: number,
  existing: readonly Cat[],
  id: number,
  rng: Rng,
  config: CatConfig = DEFAULT_CAT_CONFIG,
): Cat => {
  const size = CAT_BASE_SIZE * config.sizeScale
  const candidates = Array.from({ length: 8 }, () => ({
    x: randomBetween(size / 2, Math.max(size / 2, width - size / 2), rng),
    y: randomBetween(TOP_MARGIN + size / 2, Math.max(TOP_MARGIN + size / 2, height - size / 2), rng),
  }))
  const scored = candidates.map((c) => ({
    c,
    gap: existing.length === 0 ? Infinity : Math.min(...existing.map((cat) => distance(cat, c))),
  }))
  const best = scored.sort((a, b) => b.gap - a.gap)[0].c
  return { id, kind: pickOne(CAT_KINDS, rng), x: best.x, y: best.y, size, phase: 'appearing', phaseSec: 0 }
}

/** Draw scale for the current phase: pops in, wobbles, bounces when happy, shrinks away. */
export const catScale = (cat: Cat): number => {
  switch (cat.phase) {
    case 'appearing':
      return Math.min(1, cat.phaseSec / APPEAR_SEC)
    case 'happy':
      return 1 + 0.18 * Math.abs(Math.sin((cat.phaseSec / HAPPY_SEC) * Math.PI * 3))
    case 'leaving':
      return Math.max(0, 1 - cat.phaseSec / LEAVE_SEC)
    default:
      return 1 + 0.03 * Math.sin(cat.phaseSec * 4)
  }
}

const isTouched = (cat: Cat, pointers: readonly Pointer[], margin: number): boolean =>
  pointers.some((p) => p.points.some((point) => circleContainsPoint(cat, cat.size / 2 + margin, point)))

const advance = (cat: Cat, dtSec: number, stayForSec: number): Cat | null => {
  const phaseSec = cat.phaseSec + dtSec
  switch (cat.phase) {
    case 'appearing':
      return phaseSec >= APPEAR_SEC ? { ...cat, phase: 'waiting', phaseSec: 0 } : { ...cat, phaseSec }
    case 'waiting':
      return phaseSec >= stayForSec ? { ...cat, phase: 'leaving', phaseSec: 0 } : { ...cat, phaseSec }
    case 'happy':
      return phaseSec >= HAPPY_SEC ? null : { ...cat, phaseSec }
    case 'leaving':
      return phaseSec >= LEAVE_SEC ? null : { ...cat, phaseSec }
  }
}

export const stepCats = (
  state: CatState,
  dtSec: number,
  input: CatInput,
  rng: Rng = Math.random,
): { readonly state: CatState; readonly events: CatEvents } => {
  const config = input.config ?? DEFAULT_CAT_CONFIG
  const advanced = state.cats.map((cat) => advance(cat, dtSec, config.stayForSec)).filter((cat): cat is Cat => cat !== null)
  const tickled = advanced.filter(
    (cat) => (cat.phase === 'appearing' || cat.phase === 'waiting') && isTouched(cat, input.pointers, config.hitMarginPx),
  )
  const cats = advanced.map((cat) => (tickled.includes(cat) ? { ...cat, phase: 'happy' as const, phaseSec: 0 } : cat))

  const hearts = tickled.flatMap((cat) =>
    spawnBurst(
      { x: cat.x, y: cat.y - cat.size * 0.2 },
      { count: 14, colors: HEART_COLORS, speed: [60, 220], size: [5, 11], life: [0.6, 1.1], gravity: -120 },
      rng,
    ),
  )

  let spawnInSec = state.spawnInSec - dtSec
  let nextCats = cats
  let nextId = state.nextId
  const visible = cats.filter((c) => c.phase !== 'leaving' && c.phase !== 'happy')
  if (spawnInSec <= 0 && visible.length < config.maxCats && input.width > 0) {
    nextCats = [...cats, spawnCat(input.width, input.height, cats, nextId, rng, config)]
    nextId += 1
    spawnInSec = config.appearIntervalSec
  }

  const total = state.tickled + tickled.length
  const milestone = tickled.length > 0 && Math.floor(total / MILESTONE_EVERY) > Math.floor(state.tickled / MILESTONE_EVERY)

  return {
    state: {
      cats: nextCats,
      tickled: total,
      spawnInSec,
      particles: [...stepParticles(state.particles, dtSec), ...hearts],
      nextId,
    },
    events: { tickled, milestone },
  }
}
