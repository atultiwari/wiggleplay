import { add, average, clamp, distance, length, lerp, lerpPoint, point, scale, sub, ZERO } from './vec'

describe('vec', () => {
  it('adds, subtracts and scales without mutating inputs', () => {
    const a = point(1, 2)
    const b = point(3, 5)
    expect(add(a, b)).toEqual({ x: 4, y: 7 })
    expect(sub(b, a)).toEqual({ x: 2, y: 3 })
    expect(scale(a, 2)).toEqual({ x: 2, y: 4 })
    expect(a).toEqual({ x: 1, y: 2 })
  })

  it('measures length and distance', () => {
    expect(length(point(3, 4))).toBe(5)
    expect(distance(point(0, 0), point(6, 8))).toBe(10)
  })

  it('clamps and lerps', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
    expect(lerp(0, 10, 0.25)).toBe(2.5)
    expect(lerpPoint(point(0, 0), point(10, 20), 0.5)).toEqual({ x: 5, y: 10 })
  })

  it('averages points and returns ZERO for an empty list', () => {
    expect(average([point(0, 0), point(2, 4)])).toEqual({ x: 1, y: 2 })
    expect(average([])).toBe(ZERO)
  })
})
