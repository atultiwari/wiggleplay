import { distance, type Point } from '../math/vec'

export const circleContainsPoint = (center: Point, radius: number, p: Point): boolean =>
  distance(center, p) <= radius

/** Distance from point `p` to the closest point on segment a→b. */
export const segmentDistanceToPoint = (a: Point, b: Point, p: Point): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSq = abx * abx + aby * aby
  if (lengthSq === 0) return distance(a, p)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq))
  return distance({ x: a.x + abx * t, y: a.y + aby * t }, p)
}

export const segmentIntersectsCircle = (a: Point, b: Point, center: Point, radius: number): boolean =>
  segmentDistanceToPoint(a, b, center) <= radius
