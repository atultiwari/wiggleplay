export interface Point {
  readonly x: number
  readonly y: number
}

export const point = (x: number, y: number): Point => ({ x, y })
export const ZERO: Point = { x: 0, y: 0 }

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s })
export const length = (a: Point): number => Math.hypot(a.x, a.y)
export const distance = (a: Point, b: Point): number => length(sub(a, b))

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const lerpPoint = (a: Point, b: Point, t: number): Point => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
})

export const average = (points: readonly Point[]): Point => {
  if (points.length === 0) return ZERO
  const sum = points.reduce(add, ZERO)
  return scale(sum, 1 / points.length)
}
