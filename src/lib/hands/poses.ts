import type { HandPose } from '../../types/hand'
import { distance, scale, sub, ZERO, type Point } from '../math/vec'
import { LANDMARK, openness, palmCenter, toScreenPoints } from './features'
import { smoothPoints } from './smoothing'

export interface PoseBuildInput {
  readonly previous: readonly HandPose[]
  /** Normalised landmark sets straight from the detector. */
  readonly detected: readonly (readonly Point[])[]
  readonly width: number
  readonly height: number
  readonly mirrored: boolean
  readonly dtMs: number
  /** 0..1, share of the new position to keep per frame. */
  readonly smoothing: number
  readonly nextId: number
}

export interface PoseBuildResult {
  readonly hands: readonly HandPose[]
  readonly nextId: number
}

/** Hands further apart than this (px) are treated as different hands. */
const MATCH_DISTANCE_PX = 250

const nearestUnused = (
  palm: Point,
  candidates: readonly HandPose[],
  used: ReadonlySet<number>,
): HandPose | undefined =>
  candidates
    .filter((c) => !used.has(c.id))
    .map((c) => ({ c, d: distance(c.palm, palm) }))
    .filter(({ d }) => d < MATCH_DISTANCE_PX)
    .sort((a, b) => a.d - b.d)[0]?.c

/**
 * Turns raw detections into stable, smoothed HandPose objects with velocity.
 * Pure: never mutates `previous`.
 */
export const buildHandPoses = (input: PoseBuildInput): PoseBuildResult => {
  const used = new Set<number>()
  let nextId = input.nextId
  const dtSec = Math.max(input.dtMs, 1) / 1000

  const hands = input.detected.map((landmarks) => {
    const rawPoints = toScreenPoints(landmarks, input.width, input.height, input.mirrored)
    const match = nearestUnused(palmCenter(rawPoints), input.previous, used)
    const id = match ? match.id : nextId++
    used.add(id)

    const points = smoothPoints(match?.points, rawPoints, input.smoothing)
    const palm = palmCenter(points)
    const velocity = match ? scale(sub(palm, match.palm), 1 / dtSec) : ZERO
    return {
      id,
      tip: points[LANDMARK.INDEX_TIP],
      palm,
      velocity,
      openness: openness(points),
      points,
    }
  })

  return { hands, nextId }
}
