import { smoothPoint, smoothPoints } from './smoothing'

describe('smoothing', () => {
  it('returns the next point when there is no previous', () => {
    expect(smoothPoint(undefined, { x: 5, y: 5 }, 0.5)).toEqual({ x: 5, y: 5 })
  })

  it('blends toward the new point by alpha', () => {
    expect(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 })
    expect(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 })
  })

  it('smooths lists element-wise, tolerating missing previous entries', () => {
    const result = smoothPoints([{ x: 0, y: 0 }], [{ x: 10, y: 0 }, { x: 4, y: 4 }], 0.5)
    expect(result).toEqual([{ x: 5, y: 0 }, { x: 4, y: 4 }])
  })
})
