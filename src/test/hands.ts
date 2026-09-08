import type { HandPose } from '../types/hand'
import { LANDMARK_COUNT } from '../lib/hands/features'
import type { Point } from '../lib/math/vec'

/**
 * Synthetic normalised landmarks. `spread` 1 = fingers fully extended upward,
 * 0 = fingertips curled into the palm (a fist).
 */
export const makeLandmarks = (spread: number, offset: Point = { x: 0, y: 0 }): Point[] => {
  const wrist = { x: 0.5, y: 0.8 }
  const mcpY = 0.6
  const mcpXs = { 5: 0.38, 9: 0.5, 13: 0.58, 17: 0.66 } as const
  const tipsY = mcpY - 0.05 - spread * 0.4
  const points: Point[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.65 }))
  const set = (i: number, p: Point) => {
    points[i] = p
  }
  set(0, wrist)
  set(5, { x: mcpXs[5], y: mcpY })
  set(9, { x: mcpXs[9], y: mcpY })
  set(13, { x: mcpXs[13], y: mcpY })
  set(17, { x: mcpXs[17], y: mcpY })
  set(8, { x: mcpXs[5], y: tipsY })
  set(12, { x: mcpXs[9], y: tipsY })
  set(16, { x: mcpXs[13], y: tipsY })
  set(20, { x: mcpXs[17], y: tipsY })
  set(4, { x: 0.3, y: 0.55 })
  return points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }))
}

/** A HandPose whose every landmark sits on `tip`, handy for touch tests. */
export const makeHand = (id: number, tip: Point, overrides: Partial<HandPose> = {}): HandPose => ({
  id,
  tip,
  palm: tip,
  velocity: { x: 0, y: 0 },
  openness: 1,
  points: Array.from({ length: LANDMARK_COUNT }, () => tip),
  ...overrides,
})
