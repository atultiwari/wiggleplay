import { circleContainsPoint, segmentDistanceToPoint, segmentIntersectsCircle } from './collision'

describe('collision', () => {
  it('checks points inside circles inclusively', () => {
    expect(circleContainsPoint({ x: 0, y: 0 }, 5, { x: 3, y: 4 })).toBe(true)
    expect(circleContainsPoint({ x: 0, y: 0 }, 5, { x: 4, y: 4 })).toBe(false)
  })

  it('measures distance to a segment, clamping to its ends', () => {
    expect(segmentDistanceToPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 3 })).toBe(3)
    expect(segmentDistanceToPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 13, y: 4 })).toBe(5)
    expect(segmentDistanceToPoint({ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 5, y: 6 })).toBe(5)
  })

  it('detects a segment crossing a circle', () => {
    expect(segmentIntersectsCircle({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 3 }, 4)).toBe(true)
    expect(segmentIntersectsCircle({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }, 4)).toBe(false)
  })
})
