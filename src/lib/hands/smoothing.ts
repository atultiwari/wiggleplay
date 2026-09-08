import { lerpPoint, type Point } from '../math/vec'

/**
 * Exponential smoothing. `alpha` is how much of the new value to keep:
 * 1 = no smoothing, 0.1 = very smooth but laggy.
 */
export const smoothPoint = (previous: Point | undefined, next: Point, alpha: number): Point =>
  previous ? lerpPoint(previous, next, alpha) : next

export const smoothPoints = (
  previous: readonly Point[] | undefined,
  next: readonly Point[],
  alpha: number,
): Point[] => next.map((p, i) => smoothPoint(previous?.[i], p, alpha))
