import { makePose } from '../../test/hands'
import { POSE } from '../../lib/pose/posePointers'
import { angleDelta, detectReactions, IDLE_POSE, INITIAL_REACTIONS, poseFromLandmarks, REST_ARM_ANGLE, smoothPose } from './logic'

const raise = (landmarks: ReturnType<typeof makePose>, index: number, to: { x?: number; y?: number }) =>
  landmarks.map((l, i) => (i === index ? { ...l, x: to.x ?? l.x, y: to.y ?? l.y } : l))

describe('wiggle mirror pose mapping', () => {
  it('returns the idle pose without a body', () => {
    expect(poseFromLandmarks(null)).toBe(IDLE_POSE)
    expect(poseFromLandmarks(makePose(undefined, 0.1))).toBe(IDLE_POSE)
  })

  it('places the torso and reports visibility', () => {
    const pose = poseFromLandmarks(makePose())
    expect(pose.visible).toBe(true)
    expect(pose.x).toBeCloseTo(0, 1)
    expect(pose.y).toBeGreaterThan(0.4)
    const shifted = poseFromLandmarks(makePose({ x: -0.2, y: 0 }))
    expect(shifted.x).toBeGreaterThan(0.3)
  })

  it('swings the left arm bone by the difference from the rest angle', () => {
    // Arm hanging straight down: wrist directly below the left shoulder.
    const down = raise(makePose(), POSE.LEFT_WRIST, { x: 0.62, y: 0.6 })
    const pose = poseFromLandmarks(down)
    expect(pose.bones['arm-l'][2]).toBeCloseTo(angleDelta(-Math.PI / 2, REST_ARM_ANGLE), 2)
    expect(pose.bones['arm-l'][2]).toBeLessThan(0)
  })

  it('detects both hands above the nose as arms up', () => {
    const up = raise(raise(makePose(), POSE.LEFT_WRIST, { y: 0.05 }), POSE.RIGHT_WRIST, { y: 0.05 })
    expect(poseFromLandmarks(up).armsUp).toBe(true)
    expect(poseFromLandmarks(makePose()).armsUp).toBe(false)
  })

  it('smooths toward the target and eases back to idle when the body vanishes', () => {
    const target = poseFromLandmarks(raise(makePose(), POSE.LEFT_WRIST, { x: 0.62, y: 0.6 }))
    const half = smoothPose(IDLE_POSE, target, 0.5)
    expect(half.bones['arm-l'][2]).toBeCloseTo(target.bones['arm-l'][2] / 2, 3)
    const back = smoothPose(half, IDLE_POSE, 1)
    expect(back.bones['arm-l'][2]).toBe(0)
    expect(back.visible).toBe(false)
  })

  it('wraps angle differences', () => {
    expect(angleDelta(Math.PI * 0.9, -Math.PI * 0.9)).toBeCloseTo(-Math.PI * 0.2)
  })
})

describe('wiggle mirror reactions', () => {
  const visible = (over: Partial<typeof IDLE_POSE>) => ({ ...IDLE_POSE, visible: true, ...over })

  it('fires a hooray once per raise and respects the cooldown', () => {
    const first = detectReactions(INITIAL_REACTIONS, visible({ armsUp: true }), 0.016)
    expect(first.events.hooray).toBe(true)
    const held = detectReactions(first.state, visible({ armsUp: true }), 0.016)
    expect(held.events.hooray).toBe(false)
    const lowered = detectReactions(held.state, visible({ armsUp: false }), 0.016)
    const tooSoon = detectReactions(lowered.state, visible({ armsUp: true }), 0.016)
    expect(tooSoon.events.hooray).toBe(false)
    const later = detectReactions({ ...lowered.state, cooldownSec: 0 }, visible({ armsUp: true }), 0.016)
    expect(later.events.hooray).toBe(true)
    expect(later.state.hoorays).toBe(2)
  })

  it('detects a fast upward move as a jump', () => {
    const still = detectReactions(INITIAL_REACTIONS, visible({ y: 0.5 }), 0.016)
    const jump = detectReactions(still.state, visible({ y: 0.53 }), 0.016)
    expect(jump.events.jump).toBe(true)
    expect(jump.state.jumps).toBe(1)
    const slow = detectReactions({ ...INITIAL_REACTIONS, lastY: 0.5 }, visible({ y: 0.505 }), 0.016)
    expect(slow.events.jump).toBe(false)
  })
})
