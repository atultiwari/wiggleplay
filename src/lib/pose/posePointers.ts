import type { Pointer, PointerKind } from '../../types/pointer'
import { add, average, distance, lerpPoint, scale, sub, ZERO, type Point } from '../math/vec'
import { adaptiveAlpha } from '../hands/poses'
import { smoothPoint, smoothPoints } from '../hands/smoothing'
import type { PoseLandmark } from './PoseTracker'

/** MediaPipe pose landmark indices. */
export const POSE = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const

export const POSE_LANDMARK_COUNT = 33

/** Fixed ids so pointers stay stable without matching. */
export const POSE_POINTER_IDS = {
  body: 100,
  handLeft: 101,
  handRight: 102,
  head: 103,
  footLeft: 104,
  footRight: 105,
} as const

interface PointerSpec {
  readonly id: number
  readonly kind: PointerKind
  /** Landmarks averaged into the cursor. */
  readonly cursor: readonly number[]
  /** Landmarks that can touch things. */
  readonly touch: readonly number[]
  /** Pairs of landmarks; points along each link also touch things (arms, legs, torso). */
  readonly links: readonly (readonly [number, number])[]
  /** Landmarks that must be visible for the pointer to exist. */
  readonly required: readonly number[]
}

const P = POSE
export const POINTER_SPECS: readonly PointerSpec[] = [
  {
    id: POSE_POINTER_IDS.body,
    kind: 'body',
    cursor: [P.LEFT_SHOULDER, P.RIGHT_SHOULDER, P.LEFT_HIP, P.RIGHT_HIP],
    touch: [P.LEFT_SHOULDER, P.RIGHT_SHOULDER, P.LEFT_HIP, P.RIGHT_HIP],
    links: [
      [P.LEFT_SHOULDER, P.RIGHT_SHOULDER],
      [P.LEFT_HIP, P.RIGHT_HIP],
      [P.LEFT_SHOULDER, P.LEFT_HIP],
      [P.RIGHT_SHOULDER, P.RIGHT_HIP],
      [P.LEFT_SHOULDER, P.RIGHT_HIP],
      [P.RIGHT_SHOULDER, P.LEFT_HIP],
    ],
    required: [P.LEFT_SHOULDER, P.RIGHT_SHOULDER],
  },
  {
    id: POSE_POINTER_IDS.handLeft,
    kind: 'hand',
    cursor: [P.LEFT_WRIST, P.LEFT_INDEX, P.LEFT_PINKY, P.LEFT_THUMB],
    touch: [P.LEFT_WRIST, P.LEFT_INDEX, P.LEFT_PINKY, P.LEFT_THUMB, P.LEFT_ELBOW],
    links: [[P.LEFT_ELBOW, P.LEFT_WRIST]],
    required: [P.LEFT_WRIST],
  },
  {
    id: POSE_POINTER_IDS.handRight,
    kind: 'hand',
    cursor: [P.RIGHT_WRIST, P.RIGHT_INDEX, P.RIGHT_PINKY, P.RIGHT_THUMB],
    touch: [P.RIGHT_WRIST, P.RIGHT_INDEX, P.RIGHT_PINKY, P.RIGHT_THUMB, P.RIGHT_ELBOW],
    links: [[P.RIGHT_ELBOW, P.RIGHT_WRIST]],
    required: [P.RIGHT_WRIST],
  },
  {
    id: POSE_POINTER_IDS.head,
    kind: 'head',
    cursor: [P.NOSE],
    touch: [P.NOSE, P.LEFT_EYE, P.RIGHT_EYE, P.LEFT_EAR, P.RIGHT_EAR, P.MOUTH_LEFT, P.MOUTH_RIGHT],
    links: [[P.LEFT_EAR, P.RIGHT_EAR]],
    required: [P.NOSE],
  },
  {
    id: POSE_POINTER_IDS.footLeft,
    kind: 'foot',
    cursor: [P.LEFT_FOOT_INDEX, P.LEFT_ANKLE],
    touch: [P.LEFT_ANKLE, P.LEFT_HEEL, P.LEFT_FOOT_INDEX, P.LEFT_KNEE],
    links: [[P.LEFT_KNEE, P.LEFT_ANKLE]],
    required: [P.LEFT_ANKLE],
  },
  {
    id: POSE_POINTER_IDS.footRight,
    kind: 'foot',
    cursor: [P.RIGHT_FOOT_INDEX, P.RIGHT_ANKLE],
    touch: [P.RIGHT_ANKLE, P.RIGHT_HEEL, P.RIGHT_FOOT_INDEX, P.RIGHT_KNEE],
    links: [[P.RIGHT_KNEE, P.RIGHT_ANKLE]],
    required: [P.RIGHT_ANKLE],
  },
]

export const ALL_POINTER_KINDS: readonly PointerKind[] = ['body', 'hand', 'head', 'foot']

export interface PosePointerInput {
  readonly previous: readonly Pointer[]
  readonly landmarks: readonly PoseLandmark[] | undefined
  readonly width: number
  readonly height: number
  readonly mirrored: boolean
  readonly dtMs: number
  readonly smoothing: number
  readonly predictionSec?: number
  readonly include?: readonly PointerKind[]
  readonly minVisibility?: number
}

const LINK_STEPS = [0.33, 0.66]
const MAX_PREDICTION_PX = 80
const DEFAULT_MIN_VISIBILITY = 0.5

const toScreen = (l: Point, width: number, height: number, mirrored: boolean): Point => ({
  x: (mirrored ? 1 - l.x : l.x) * width,
  y: l.y * height,
})

const cappedOffset = (velocity: Point, predictionSec: number): Point => {
  const offset = scale(velocity, predictionSec)
  const magnitude = Math.hypot(offset.x, offset.y)
  return magnitude <= MAX_PREDICTION_PX ? offset : scale(offset, MAX_PREDICTION_PX / magnitude)
}

/** Builds body-part pointers from one person's pose landmarks. Pure. */
export const buildPosePointers = (input: PosePointerInput): readonly Pointer[] => {
  const landmarks = input.landmarks
  if (!landmarks || landmarks.length < POSE_LANDMARK_COUNT) return []
  const include = input.include ?? ALL_POINTER_KINDS
  const minVisibility = input.minVisibility ?? DEFAULT_MIN_VISIBILITY
  const dtSec = Math.max(input.dtMs, 1) / 1000
  const predictionSec = input.predictionSec ?? 0
  const screen = landmarks.map((l) => toScreen(l, input.width, input.height, input.mirrored))

  return POINTER_SPECS.filter((spec) => include.includes(spec.kind))
    .filter((spec) => spec.required.every((i) => landmarks[i].visibility >= minVisibility))
    .map((spec) => {
      const rawTouch = [
        ...spec.touch.map((i) => screen[i]),
        ...spec.links.flatMap(([a, b]) => LINK_STEPS.map((t) => lerpPoint(screen[a], screen[b], t))),
      ]
      const rawCursor = average(spec.cursor.map((i) => screen[i]))
      const previous = input.previous.find((p) => p.id === spec.id)
      const speed = previous ? distance(rawCursor, previous.palm) / dtSec : 0
      const alpha = adaptiveAlpha(input.smoothing, speed)
      const cursor = smoothPoint(previous?.palm, rawCursor, alpha)
      const touch = smoothPoints(previous?.points.length === rawTouch.length ? previous.points : undefined, rawTouch, alpha)
      const velocity = previous ? scale(sub(cursor, previous.palm), 1 / dtSec) : ZERO
      const offset = previous && predictionSec > 0 ? cappedOffset(velocity, predictionSec) : ZERO
      const palm = add(cursor, offset)
      return {
        id: spec.id,
        kind: spec.kind,
        tip: palm,
        palm,
        velocity,
        openness: 1,
        points: offset === ZERO ? touch : touch.map((p) => add(p, offset)),
      }
    })
}
