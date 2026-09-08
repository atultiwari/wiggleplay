import type { Point } from '../lib/math/vec'

/** A tracked hand, in canvas pixel coordinates (already mirrored for selfie view). */
export interface HandPose {
  /** Stable id across frames while the hand stays in view. */
  readonly id: number
  /** Index fingertip. */
  readonly tip: Point
  /** Centre of the palm. */
  readonly palm: Point
  /** Palm velocity in px/s. */
  readonly velocity: Point
  /** 0 = tight fist, 1 = fully open hand. */
  readonly openness: number
  /** All 21 MediaPipe landmarks in canvas pixels. */
  readonly points: readonly Point[]
}
