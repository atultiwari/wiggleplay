import { describe, expect, it } from 'vitest'
import { POSE } from '../../lib/pose/posePointers'
import type { PoseLandmark } from '../../lib/pose/PoseTracker'
import { ASK_SEC, availableMoves, CELEBRATE_SEC, createSimonState, EMPTY_FRAME, frameFromLandmarks, HOLD_SEC, poseMatches, stepSimon, WAIT_SEC, type BodyFrame, type SimonState } from './logic'

/** A person standing straight, arms down, normalised image coordinates (y grows downward). */
const standing = (): PoseLandmark[] => {
  const lm: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
  const set = (i: number, x: number, y: number) => {
    lm[i] = { x, y, visibility: 1 }
  }
  set(POSE.NOSE, 0.5, 0.2)
  set(POSE.LEFT_EYE, 0.52, 0.18)
  set(POSE.RIGHT_EYE, 0.48, 0.18)
  set(POSE.LEFT_SHOULDER, 0.6, 0.35)
  set(POSE.RIGHT_SHOULDER, 0.4, 0.35)
  set(POSE.LEFT_HIP, 0.57, 0.6)
  set(POSE.RIGHT_HIP, 0.43, 0.6)
  set(POSE.LEFT_WRIST, 0.66, 0.62)
  set(POSE.RIGHT_WRIST, 0.34, 0.62)
  set(POSE.LEFT_ANKLE, 0.56, 0.92)
  set(POSE.RIGHT_ANKLE, 0.44, 0.92)
  return lm
}
const withWrists = (l: [number, number], r: [number, number]) => {
  const lm = standing()
  lm[POSE.LEFT_WRIST] = { x: l[0], y: l[1], visibility: 1 }
  lm[POSE.RIGHT_WRIST] = { x: r[0], y: r[1], visibility: 1 }
  return frameFromLandmarks(lm)
}
const idle = frameFromLandmarks(standing())
const run = (state: SimonState, seconds: number, frame: BodyFrame, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepSimon(current, dt, { frame }, () => 0.1).state
  return current
}

describe('simon says pose matching', () => {
  it('reads a frame from landmarks and rejects a missing body', () => {
    expect(idle.visible).toBe(true)
    expect(idle.shoulderWidth).toBeCloseTo(0.2)
    expect(frameFromLandmarks(null)).toBe(EMPTY_FRAME)
    expect(poseMatches('hands-up', EMPTY_FRAME)).toBe(false)
  })

  it('recognises hands up, touch nose, touch head, clap and touch tummy', () => {
    expect(poseMatches('hands-up', idle)).toBe(false)
    expect(poseMatches('hands-up', withWrists([0.62, 0.1], [0.38, 0.1]))).toBe(true)
    expect(poseMatches('touch-nose', withWrists([0.52, 0.22], [0.34, 0.62]))).toBe(true)
    expect(poseMatches('touch-nose', idle)).toBe(false)
    expect(poseMatches('touch-head', withWrists([0.5, 0.1], [0.34, 0.62]))).toBe(true)
    expect(poseMatches('touch-head', withWrists([0.9, 0.1], [0.34, 0.62]))).toBe(false)
    expect(poseMatches('clap', withWrists([0.52, 0.5], [0.48, 0.5]))).toBe(true)
    expect(poseMatches('clap', idle)).toBe(false)
    expect(poseMatches('touch-tummy', withWrists([0.5, 0.55], [0.34, 0.62]))).toBe(true)
  })

  it('recognises standing on one foot', () => {
    const lm = standing()
    lm[POSE.LEFT_ANKLE] = { x: 0.56, y: 0.78, visibility: 1 }
    expect(poseMatches('one-foot', frameFromLandmarks(lm))).toBe(true)
    expect(poseMatches('one-foot', idle)).toBe(false)
  })
})

describe('simon says flow', () => {
  it('asks, waits for a held pose, celebrates and rests before the next move', () => {
    const state = createSimonState(undefined, () => 0)   // first easy move: hands-up
    expect(state.move).toBe('hands-up')
    const asked = stepSimon(state, 0.05, { frame: idle })
    expect(asked.events.asked).toBe('hands-up')
    const waiting = run(asked.state, ASK_SEC, idle)
    expect(waiting.phase).toBe('waiting')
    const up = withWrists([0.62, 0.1], [0.38, 0.1])
    const flash = stepSimon(waiting, 0.05, { frame: up }).state
    expect(flash.phase).toBe('waiting')
    let current = flash
    let done = null
    for (let t = 0; t < HOLD_SEC + 0.1 && !done; t += 0.05) {
      const step = stepSimon(current, 0.05, { frame: up })
      current = step.state
      done = step.events.done
    }
    expect(done).toBe('hands-up')
    expect(current.done).toBe(1)
    const rested = run(current, CELEBRATE_SEC + 4.1, idle)
    expect(rested.phase).toBe('asking')
    expect(rested.move).not.toBe('hands-up')
  })

  it('skips a move nobody does and picks another', () => {
    const waiting = run(createSimonState(undefined, () => 0), ASK_SEC + 0.1, idle)
    let current = waiting
    let skipped = null
    for (let t = 0; t < WAIT_SEC + 0.2 && !skipped; t += 0.05) {
      const step = stepSimon(current, 0.05, { frame: idle }, () => 0.5)
      current = step.state
      skipped = step.events.skipped
    }
    expect(skipped).toBe('hands-up')
    expect(current.phase).toBe('asking')
    expect(current.move).not.toBe('hands-up')
  })

  it('detects a jump from the torso rising quickly and a wave from side-to-side motion', () => {
    const config = { gapSec: 4, harderMoves: true }
    const jumpState: SimonState = { ...createSimonState(config, () => 0), move: 'jump', phase: 'waiting', lastTorsoY: idle.torsoY }
    const risen = frameFromLandmarks(standing().map((p) => ({ ...p, y: p.y - 0.06 })))
    expect(stepSimon(jumpState, 0.05, { frame: risen, config }).events.done).toBe('jump')

    let waveState: SimonState = { ...createSimonState(), move: 'wave', phase: 'waiting' }
    let done: string | null = null
    const xs = [0.6, 0.66, 0.72, 0.66, 0.6, 0.54, 0.6, 0.66, 0.72]
    xs.forEach((x) => {
      const step = stepSimon(waveState, 0.08, { frame: withWrists([x, 0.2], [0.34, 0.62]) })
      waveState = step.state
      done = done ?? step.events.done
    })
    expect(done).toBe('wave')
  })

  it('only offers the harder moves when enabled', () => {
    expect(availableMoves({ gapSec: 4, harderMoves: false })).not.toContain('jump')
    expect(availableMoves({ gapSec: 4, harderMoves: true })).toContain('one-foot')
  })
})
