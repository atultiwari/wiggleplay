import { average, clamp, distance, type Point } from '../math/vec'

/** MediaPipe hand landmark indices we care about. */
export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
} as const

export const LANDMARK_COUNT = 21
const FINGERTIPS = [LANDMARK.INDEX_TIP, LANDMARK.MIDDLE_TIP, LANDMARK.RING_TIP, LANDMARK.PINKY_TIP]
const PALM_POINTS = [LANDMARK.WRIST, LANDMARK.INDEX_MCP, LANDMARK.MIDDLE_MCP, LANDMARK.RING_MCP, LANDMARK.PINKY_MCP]

/** Raw openness ratio of a closed fist / open hand, measured empirically. */
const OPENNESS_FIST = 0.8
const OPENNESS_OPEN = 1.9
export const FIST_THRESHOLD = 0.3

/** Convert normalised (0..1) landmarks to canvas pixels, optionally mirrored for selfie view. */
export const toScreenPoints = (
  landmarks: readonly Point[],
  width: number,
  height: number,
  mirrored: boolean,
): Point[] =>
  landmarks.map((l) => ({ x: (mirrored ? 1 - l.x : l.x) * width, y: l.y * height }))

export const palmCenter = (points: readonly Point[]): Point =>
  average(PALM_POINTS.map((i) => points[i]))

export const palmSize = (points: readonly Point[]): number =>
  distance(points[LANDMARK.WRIST], points[LANDMARK.MIDDLE_MCP])

/** 0 = fist, 1 = open hand. Independent of hand distance from the camera. */
export const openness = (points: readonly Point[]): number => {
  const size = palmSize(points)
  if (size === 0) return 0
  const centre = palmCenter(points)
  const meanReach =
    FINGERTIPS.reduce((sum, i) => sum + distance(points[i], centre), 0) / FINGERTIPS.length
  const ratio = meanReach / size
  return clamp((ratio - OPENNESS_FIST) / (OPENNESS_OPEN - OPENNESS_FIST), 0, 1)
}

export const isFist = (points: readonly Point[]): boolean => openness(points) < FIST_THRESHOLD
