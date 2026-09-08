import { makeLandmarks } from '../../test/hands'
import { isFist, LANDMARK, openness, palmCenter, palmSize, toScreenPoints } from './features'

describe('hand features', () => {
  it('maps normalised landmarks to mirrored screen pixels', () => {
    const [p] = toScreenPoints([{ x: 0.25, y: 0.5 }], 400, 200, true)
    expect(p).toEqual({ x: 300, y: 100 })
    const [q] = toScreenPoints([{ x: 0.25, y: 0.5 }], 400, 200, false)
    expect(q).toEqual({ x: 100, y: 100 })
  })

  it('computes palm centre and size from wrist and knuckles', () => {
    const points = makeLandmarks(1)
    const centre = palmCenter(points)
    expect(centre.x).toBeCloseTo((0.5 + 0.38 + 0.5 + 0.58 + 0.66) / 5)
    expect(centre.y).toBeCloseTo((0.8 + 0.6 * 4) / 5)
    expect(palmSize(points)).toBeCloseTo(0.2)
    expect(points[LANDMARK.WRIST]).toEqual({ x: 0.5, y: 0.8 })
  })

  it('reports an open hand as ~1 and a fist as ~0', () => {
    expect(openness(makeLandmarks(1))).toBeGreaterThan(0.85)
    expect(openness(makeLandmarks(0))).toBeLessThan(0.15)
    expect(isFist(makeLandmarks(0))).toBe(true)
    expect(isFist(makeLandmarks(1))).toBe(false)
  })

  it('returns 0 openness when the palm has no size', () => {
    const collapsed = makeLandmarks(1).map(() => ({ x: 0.5, y: 0.5 }))
    expect(openness(collapsed)).toBe(0)
  })
})
