import { makePose } from '../../test/hands'
import { buildPosePointers, POSE_POINTER_IDS } from './posePointers'

const base = { width: 1000, height: 500, mirrored: false, dtMs: 100, smoothing: 1 }

describe('buildPosePointers', () => {
  it('returns nothing without a person', () => {
    expect(buildPosePointers({ ...base, previous: [], landmarks: undefined })).toEqual([])
    expect(buildPosePointers({ ...base, previous: [], landmarks: makePose().slice(0, 10) })).toEqual([])
  })

  it('builds body, two hands, head and two feet with stable ids', () => {
    const pointers = buildPosePointers({ ...base, previous: [], landmarks: makePose() })
    expect(pointers.map((p) => p.kind).sort()).toEqual(['body', 'foot', 'foot', 'hand', 'hand', 'head'])
    const head = pointers.find((p) => p.id === POSE_POINTER_IDS.head)
    expect(head?.tip).toEqual({ x: 500, y: 75 })
    const body = pointers.find((p) => p.id === POSE_POINTER_IDS.body)
    expect(body?.palm.x).toBeCloseTo(500)
    expect(body?.palm.y).toBeCloseTo(225)
    expect(body?.points.length).toBeGreaterThan(4)
    pointers.forEach((p) => expect(p.openness).toBe(1))
  })

  it('mirrors for selfie view and honours the include filter', () => {
    const pointers = buildPosePointers({ ...base, mirrored: true, previous: [], landmarks: makePose(), include: ['head'] })
    expect(pointers).toHaveLength(1)
    expect(pointers[0].kind).toBe('head')
    expect(pointers[0].tip.x).toBeCloseTo(500)
    const shifted = buildPosePointers({ ...base, mirrored: true, previous: [], landmarks: makePose({ x: 0.1, y: 0 }), include: ['head'] })
    expect(shifted[0].tip.x).toBeCloseTo(400)
  })

  it('drops parts that are not visible', () => {
    const landmarks = makePose().map((l, i) => (i === 27 ? { ...l, visibility: 0.1 } : l))
    const pointers = buildPosePointers({ ...base, previous: [], landmarks })
    expect(pointers.some((p) => p.id === POSE_POINTER_IDS.footLeft)).toBe(false)
    expect(pointers.some((p) => p.id === POSE_POINTER_IDS.footRight)).toBe(true)
  })

  it('reports velocity, smooths slow motion and predicts ahead', () => {
    const first = buildPosePointers({ ...base, previous: [], landmarks: makePose() })
    const moved = makePose({ x: 0.05, y: 0 })
    const next = buildPosePointers({ ...base, previous: first, landmarks: moved })
    const head = next.find((p) => p.kind === 'head')!
    expect(head.velocity.x).toBeCloseTo(500)
    const slow = buildPosePointers({ ...base, dtMs: 20000, smoothing: 0.5, previous: first, landmarks: moved })
    expect(slow.find((p) => p.kind === 'head')!.tip.x).toBeCloseTo(525, 0)
    const predicted = buildPosePointers({ ...base, predictionSec: 0.05, previous: first, landmarks: moved })
    expect(predicted.find((p) => p.kind === 'head')!.tip.x).toBeGreaterThan(head.tip.x)
  })
})
