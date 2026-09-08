import { makeLandmarks } from '../../test/hands'
import { adaptiveAlpha, buildHandPoses, SNAP_SPEED_PX_PER_SEC } from './poses'

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

  it('smooths slow movements but follows fast ones almost raw', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const moved = makeLandmarks(1, { x: 0.1, y: 0 })
    const slow = buildHandPoses({ ...base, dtMs: 20000, smoothing: 0.5, previous: first.hands, detected: [moved], nextId: 2 })
    expect(slow.hands[0].tip.x).toBeCloseTo(430, 0)
    const fast = buildHandPoses({ ...base, dtMs: 50, smoothing: 0.5, previous: first.hands, detected: [moved], nextId: 2 })
    expect(fast.hands[0].tip.x).toBeCloseTo(480, 0)
  })

  it('predicts a little ahead along the velocity, capped', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const moved = makeLandmarks(1, { x: 0.05, y: 0 })
    const plain = buildHandPoses({ ...base, smoothing: 1, previous: first.hands, detected: [moved], nextId: 2 })
    const predicted = buildHandPoses({ ...base, smoothing: 1, predictionSec: 0.05, previous: first.hands, detected: [moved], nextId: 2 })
    expect(predicted.hands[0].tip.x).toBeGreaterThan(plain.hands[0].tip.x)
    expect(predicted.hands[0].tip.x - plain.hands[0].tip.x).toBeLessThanOrEqual(80.001)
    expect(predicted.hands[0].palm.x - plain.hands[0].palm.x).toBeCloseTo(predicted.hands[0].tip.x - plain.hands[0].tip.x)
  })

  it('exposes the adaptive alpha curve', () => {
    expect(adaptiveAlpha(0.3, 0)).toBeCloseTo(0.3)
    expect(adaptiveAlpha(0.3, SNAP_SPEED_PX_PER_SEC)).toBe(1)
    expect(adaptiveAlpha(0.3, SNAP_SPEED_PX_PER_SEC / 2)).toBeCloseTo(0.65)
  })

  it('never mutates previous poses', () => {
    const first = buildHandPoses({ ...base, previous: [], detected: [makeLandmarks(1)] })
    const snapshot = JSON.stringify(first.hands)
    buildHandPoses({ ...base, previous: first.hands, detected: [makeLandmarks(0)], nextId: 2 })
    expect(JSON.stringify(first.hands)).toBe(snapshot)
  })
})
