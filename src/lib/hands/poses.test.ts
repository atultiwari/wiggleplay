import { makeLandmarks } from '../../test/hands'
import { buildHandPoses } from './poses'

const base = { width: 1000, height: 500, mirrored: false, dtMs: 100, smoothing: 1, nextId: 1 }

describe('buildHandPoses', () => {
  it('assigns fresh ids to new hands and converts to pixels', () => {
    const result = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    expect(result.hands).toHaveLength(1)
    expect(result.hands[0].id).toBe(1)
    expect(result.nextId).toBe(2)
    expect(result.hands[0].tip.x).toBeCloseTo(380)
    expect(result.hands[0].tip.y).toBeCloseTo(75)
    expect(result.hands[0].velocity).toEqual({ x: 0, y: 0 })
    expect(result.hands[0].openness).toBeGreaterThan(0.85)
  })

  it('keeps the id of a hand that moved a little and reports its velocity', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const moved = makeLandmarks(1, { x: 0.05, y: 0 })
    const second = buildHandPoses({ ...base, previous: first.hands, detected: [moved], nextId: first.nextId })
    expect(second.hands[0].id).toBe(1)
    expect(second.hands[0].velocity.x).toBeCloseTo(500)
    expect(second.hands[0].velocity.y).toBeCloseTo(0)
    expect(second.nextId).toBe(2)
  })

  it('treats a hand far from any previous one as new', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const far = makeLandmarks(1, { x: 0.45, y: 0 })
    const second = buildHandPoses({ ...base, previous: first.hands, detected: [far], nextId: first.nextId })
    expect(second.hands[0].id).toBe(2)
  })

  it('applies smoothing between frames', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const moved = makeLandmarks(1, { x: 0.1, y: 0 })
    const second = buildHandPoses({ ...base, smoothing: 0.5, previous: first.hands, detected: [moved], nextId: 2 })
    expect(second.hands[0].tip.x).toBeCloseTo(430)
  })

  it('never mutates previous poses', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const snapshot = JSON.stringify(first.hands)
    buildHandPoses({ ...base, previous: first.hands, detected: [makeLandmarks(0)], nextId: 2 })
    expect(JSON.stringify(first.hands)).toBe(snapshot)
  })
})
