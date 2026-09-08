import type { Pointer } from '../types/pointer'
import { LANDMARK_COUNT } from '../lib/hands/features'
import type { Point } from '../lib/math/vec'
import type { PoseLandmark } from '../lib/pose/PoseTracker'
import { POSE, POSE_LANDMARK_COUNT } from '../lib/pose/posePointers'

/**
 * Synthetic normalised hand landmarks. `spread` 1 = fingers fully extended upward,
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

/** A hand Pointer whose every landmark sits on `tip`, handy for touch tests. */
export const makeHand = (id: number, tip: Point, overrides: Partial<Pointer> = {}): Pointer => ({
  id,
  kind: 'hand',
  tip,
  palm: tip,
  velocity: { x: 0, y: 0 },
  openness: 1,
  points: Array.from({ length: LANDMARK_COUNT }, () => tip),
  ...overrides,
})

/** A pointer of any kind sitting entirely on one point. */
export const makePointer = (id: number, kind: Pointer['kind'], at: Point): Pointer => ({
  id,
  kind,
  tip: at,
  palm: at,
  velocity: { x: 0, y: 0 },
  openness: 1,
  points: [at],
})

/**
 * A synthetic standing person in normalised coordinates, facing the camera,
 * with every joint visible. `offset` shifts the whole body.
 */
export const makePose = (offset: Point = { x: 0, y: 0 }, visibility = 1): PoseLandmark[] => {
  const joints: Record<number, Point> = {
    [POSE.NOSE]: { x: 0.5, y: 0.15 },
    [POSE.LEFT_EYE]: { x: 0.52, y: 0.13 },
    [POSE.RIGHT_EYE]: { x: 0.48, y: 0.13 },
    [POSE.LEFT_EAR]: { x: 0.55, y: 0.15 },
    [POSE.RIGHT_EAR]: { x: 0.45, y: 0.15 },
    [POSE.MOUTH_LEFT]: { x: 0.51, y: 0.18 },
    [POSE.MOUTH_RIGHT]: { x: 0.49, y: 0.18 },
    [POSE.LEFT_SHOULDER]: { x: 0.62, y: 0.3 },
    [POSE.RIGHT_SHOULDER]: { x: 0.38, y: 0.3 },
    [POSE.LEFT_ELBOW]: { x: 0.7, y: 0.45 },
    [POSE.RIGHT_ELBOW]: { x: 0.3, y: 0.45 },
    [POSE.LEFT_WRIST]: { x: 0.75, y: 0.6 },
    [POSE.RIGHT_WRIST]: { x: 0.25, y: 0.6 },
    [POSE.LEFT_PINKY]: { x: 0.77, y: 0.63 },
    [POSE.RIGHT_PINKY]: { x: 0.23, y: 0.63 },
    [POSE.LEFT_INDEX]: { x: 0.76, y: 0.64 },
    [POSE.RIGHT_INDEX]: { x: 0.24, y: 0.64 },
    [POSE.LEFT_THUMB]: { x: 0.74, y: 0.62 },
    [POSE.RIGHT_THUMB]: { x: 0.26, y: 0.62 },
    [POSE.LEFT_HIP]: { x: 0.58, y: 0.6 },
    [POSE.RIGHT_HIP]: { x: 0.42, y: 0.6 },
    [POSE.LEFT_KNEE]: { x: 0.58, y: 0.78 },
    [POSE.RIGHT_KNEE]: { x: 0.42, y: 0.78 },
    [POSE.LEFT_ANKLE]: { x: 0.58, y: 0.93 },
    [POSE.RIGHT_ANKLE]: { x: 0.42, y: 0.93 },
    [POSE.LEFT_HEEL]: { x: 0.57, y: 0.95 },
    [POSE.RIGHT_HEEL]: { x: 0.43, y: 0.95 },
    [POSE.LEFT_FOOT_INDEX]: { x: 0.6, y: 0.96 },
    [POSE.RIGHT_FOOT_INDEX]: { x: 0.4, y: 0.96 },
  }
  return Array.from({ length: POSE_LANDMARK_COUNT }, (_, i) => {
    const p = joints[i] ?? { x: 0.5, y: 0.5 }
    return { x: p.x + offset.x, y: p.y + offset.y, visibility }
  })
}
