import type { Point } from '../lib/math/vec'

/** Which body part a pointer comes from. Games can prefer some kinds over others. */
export type PointerKind = 'hand' | 'head' | 'foot' | 'body'

/**
 * Something the child controls on screen, in canvas pixels (mirrored for selfie view).
 * A pointer may be a tracked hand, or a head / foot / torso from body tracking.
 */
export interface Pointer {
  /** Stable id across frames while the part stays in view. */
  readonly id: number
  readonly kind: PointerKind
  /** The precise cursor: fingertip, palm, nose, toe or torso centre depending on mode. */
  readonly tip: Point
  /** Centre of the part (palm centre for hands). */
  readonly palm: Point
  /** Velocity of the centre in px/s. */
  readonly velocity: Point
  /** 0 = tight fist, 1 = open. Always 1 for non-hand pointers. */
  readonly openness: number
  /** Every point that can touch things: all 21 hand landmarks, or the joints of a limb. */
  readonly points: readonly Point[]
}
