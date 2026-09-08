import type { Pointer } from '../../types/pointer'
import { add, clamp, distance, lerp, scale, sub, ZERO, type Point } from '../math/vec'
import { LANDMARK, openness, palmCenter, toScreenPoints } from './features'
import { smoothPoints } from './smoothing'

export interface PoseBuildInput {
  readonly previous: readonly Pointer[]
  /** Normalised landmark sets straight from the detector. */
  readonly detected: readonly (readonly Point[])[]
  readonly width: number
  readonly height: number
  readonly mirrored: boolean
  readonly dtMs: number
  /**
   * Minimum share (0..1) of the new position kept per frame. Fast movements
   * are smoothed less, so this mostly affects slow, careful movements.
   */
  readonly smoothing: number
  /** Seconds of motion to extrapolate, hiding camera latency. 0 disables. */
  readonly predictionSec?: number
  /** 'tip' = index fingertip is the cursor, 'palm' = palm centre (more forgiving). */
  readonly cursor?: 'tip' | 'palm'
  readonly nextId: number
}

export interface PoseBuildResult {
  readonly hands: readonly Pointer[]
  readonly nextId: number
}

/** Hands further apart than this (px) are treated as different hands. */
const MATCH_DISTANCE_PX = 250
/** At this palm speed (px/s) smoothing is switched off entirely. */
export const SNAP_SPEED_PX_PER_SEC = 900
const MAX_PREDICTION_PX = 80

/** Speed-aware smoothing factor: slow = smooth, fast = follow the raw signal. */
export const adaptiveAlpha = (minAlpha: number, speedPxPerSec: number): number =>
  lerp(clamp(minAlpha, 0, 1), 1, clamp(speedPxPerSec / SNAP_SPEED_PX_PER_SEC, 0, 1))

const nearestUnused = (
  palm: Point,
  candidates: readonly Pointer[],
  used: ReadonlySet<number>,
): Pointer | undefined =>
  candidates
    .filter((c) => !used.has(c.id))
    .map((c) => ({ c, d: distance(c.palm, palm) }))
    .filter(({ d }) => d < MATCH_DISTANCE_PX)
    .sort((a, b) => a.d - b.d)[0]?.c

const predictionOffset = (velocity: Point, predictionSec: number): Point => {
  const offset = scale(velocity, predictionSec)
  const magnitude = Math.hypot(offset.x, offset.y)
  if (magnitude <= MAX_PREDICTION_PX) return offset
  return scale(offset, MAX_PREDICTION_PX / magnitude)
}

/**
 * Turns raw detections into stable, smoothed Pointer objects with velocity.
 * Pure: never mutates `previous`.
 */
export const buildHandPoses = (input: PoseBuildInput): PoseBuildResult => {
  const used = new Set<number>()
  let nextId = input.nextId
  const dtSec = Math.max(input.dtMs, 1) / 1000
  const predictionSec = input.predictionSec ?? 0

  const hands = input.detected.map((landmarks) => {
    const rawPoints = toScreenPoints(landmarks, input.width, input.height, input.mirrored)
    const rawPalm = palmCenter(rawPoints)
    const match = nearestUnused(rawPalm, input.previous, used)
    const id = match ? match.id : nextId++
    used.add(id)

    const rawSpeed = match ? distance(rawPalm, match.palm) / dtSec : 0
    const alpha = adaptiveAlpha(input.smoothing, rawSpeed)
    const smoothed = smoothPoints(match?.points, rawPoints, alpha)
    const smoothedPalm = palmCenter(smoothed)
    const velocity = match ? scale(sub(smoothedPalm, match.palm), 1 / dtSec) : ZERO
    const offset = match && predictionSec > 0 ? predictionOffset(velocity, predictionSec) : ZERO
    const points = offset === ZERO ? smoothed : smoothed.map((p) => add(p, offset))
    const palm = add(smoothedPalm, offset)

    return {
      id,
      kind: 'hand' as const,
      tip: input.cursor === 'palm' ? palm : points[LANDMARK.INDEX_TIP],
      palm,
      velocity,
      openness: openness(points),
      points,
    }
  })

  return { hands, nextId }
}
