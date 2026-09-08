import { POSE } from '../../lib/pose/posePointers'
import type { PoseLandmark } from '../../lib/pose/PoseTracker'
import { clamp, lerp } from '../../lib/math/vec'

/**
 * Pure mapping from MediaPipe pose landmarks to the mascot rig.
 *
 * The rig's rest pose is the sticker's "hooray" pose: arm-l points from the left shoulder
 * up-outward at REST_ARM_ANGLE, arm-r mirrors it, both feet point straight down.
 * Every bone rotation here is the in-plane (about z) angle needed to turn that rest
 * direction into the child's limb direction, measured in mirrored screen space so the
 * child's left arm drives the puppet's left arm (which appears on the viewer's right,
 * exactly like a mirror).
 */
export type BoneRotation = readonly [number, number, number]

export interface PuppetPose {
  /** Horizontal position of the torso centre, -1 (left edge) .. +1 (right edge), mirrored. */
  readonly x: number
  /** Vertical position of the torso centre, 0 (bottom) .. 1 (top). */
  readonly y: number
  /** Relative body size from shoulder width; 1 = the calibration width. */
  readonly scale: number
  readonly bones: Readonly<Record<string, BoneRotation>>
  readonly armsUp: boolean
  readonly visible: boolean
}

export interface PuppetConfig {
  /** Share of the new pose kept per frame (0..1). */
  readonly smoothing: number
  readonly minVisibility: number
}

export const DEFAULT_PUPPET_CONFIG: PuppetConfig = { smoothing: 0.45, minVisibility: 0.5 }

/** Rest direction of arm-l in the rig (from shoulder socket to wrist), radians above +x. */
export const REST_ARM_ANGLE = Math.atan2(0.03 - -0.09, 0.48 - 0.35)
/** Rest direction of foot-l (straight down). */
export const REST_FOOT_ANGLE = -Math.PI / 2
/** Shoulder width (normalised image units) that maps to puppet scale 1. */
export const CALIBRATION_SHOULDER_WIDTH = 0.22
const MAX_ARM_SWING = Math.PI * 0.9
const MAX_FOOT_SWING = Math.PI * 0.35
const MAX_LEAN = 0.35

export const IDLE_POSE: PuppetPose = {
  x: 0,
  y: 0.5,
  scale: 1,
  bones: { 'arm-l': [0, 0, 0], 'arm-r': [0, 0, 0], 'hand-l': [0, 0, 0], 'hand-r': [0, 0, 0], 'foot-l': [0, 0, 0], 'foot-r': [0, 0, 0], body: [0, 0, 0] },
  armsUp: false,
  visible: false,
}

interface Pt {
  readonly x: number
  readonly y: number
}

/** Mirrored screen point with y up (0 bottom, 1 top). */
const screen = (l: PoseLandmark): Pt => ({ x: 1 - l.x, y: 1 - l.y })

const angleOf = (from: Pt, to: Pt): number => Math.atan2(to.y - from.y, to.x - from.x)

/** Shortest signed difference between two angles. */
export const angleDelta = (target: number, rest: number): number => {
  let d = target - rest
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

const lerpRotation = (a: BoneRotation, b: BoneRotation, t: number): BoneRotation => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

/** Maps one frame of landmarks to a raw (unsmoothed) puppet pose, or IDLE when the body is not visible. */
export const poseFromLandmarks = (landmarks: readonly PoseLandmark[] | null, config: PuppetConfig = DEFAULT_PUPPET_CONFIG): PuppetPose => {
  if (!landmarks || landmarks.length < 33) return IDLE_POSE
  const visible = (i: number) => landmarks[i].visibility >= config.minVisibility
  if (!visible(POSE.LEFT_SHOULDER) || !visible(POSE.RIGHT_SHOULDER)) return IDLE_POSE

  const ls = screen(landmarks[POSE.LEFT_SHOULDER])
  const rs = screen(landmarks[POSE.RIGHT_SHOULDER])
  const lh = screen(landmarks[POSE.LEFT_HIP])
  const rh = screen(landmarks[POSE.RIGHT_HIP])
  const shoulders = mid(ls, rs)
  const hips = visible(POSE.LEFT_HIP) && visible(POSE.RIGHT_HIP) ? mid(lh, rh) : { x: shoulders.x, y: shoulders.y - 0.25 }
  const torso = mid(shoulders, hips)
  const shoulderWidth = Math.max(0.05, Math.abs(ls.x - rs.x))

  const armRotation = (shoulder: Pt, wristIndex: number, rest: number): BoneRotation => {
    if (!visible(wristIndex)) return [0, 0, 0]
    const wrist = screen(landmarks[wristIndex])
    return [0, 0, clamp(angleDelta(angleOf(shoulder, wrist), rest), -MAX_ARM_SWING, MAX_ARM_SWING)]
  }
  const footRotation = (hip: Pt, ankleIndex: number, rest: number): BoneRotation => {
    if (!visible(ankleIndex)) return [0, 0, 0]
    const ankle = screen(landmarks[ankleIndex])
    return [0, 0, clamp(angleDelta(angleOf(hip, ankle), rest), -MAX_FOOT_SWING, MAX_FOOT_SWING)]
  }
  // The rig's right arm rests mirrored: pointing up-outward toward -x.
  const restArmR = Math.PI - REST_ARM_ANGLE
  const lean = clamp(angleDelta(angleOf(hips, shoulders), Math.PI / 2), -MAX_LEAN, MAX_LEAN)

  const lw = visible(POSE.LEFT_WRIST) ? screen(landmarks[POSE.LEFT_WRIST]) : null
  const rw = visible(POSE.RIGHT_WRIST) ? screen(landmarks[POSE.RIGHT_WRIST]) : null
  const nose = visible(POSE.NOSE) ? screen(landmarks[POSE.NOSE]) : shoulders
  const armsUp = !!lw && !!rw && lw.y > nose.y && rw.y > nose.y

  return {
    x: clamp((torso.x - 0.5) * 2, -1, 1),
    y: clamp(torso.y, 0, 1),
    scale: clamp(shoulderWidth / CALIBRATION_SHOULDER_WIDTH, 0.5, 1.8),
    bones: {
      'arm-l': armRotation(ls, POSE.LEFT_WRIST, REST_ARM_ANGLE),
      'arm-r': armRotation(rs, POSE.RIGHT_WRIST, restArmR),
      'hand-l': [0, 0, 0],
      'hand-r': [0, 0, 0],
      'foot-l': footRotation(lh, POSE.LEFT_ANKLE, REST_FOOT_ANGLE),
      'foot-r': footRotation(rh, POSE.RIGHT_ANKLE, REST_FOOT_ANGLE),
      body: [0, 0, lean],
    },
    armsUp,
    visible: true,
  }
}

/** Exponentially smooths toward the target pose; an invisible target eases back to idle. */
export const smoothPose = (previous: PuppetPose, target: PuppetPose, alpha: number): PuppetPose => {
  const goal = target.visible ? target : { ...IDLE_POSE, x: previous.x, y: previous.y, scale: previous.scale }
  const bones = Object.fromEntries(
    Object.keys(IDLE_POSE.bones).map((id) => [id, lerpRotation(previous.bones[id] ?? [0, 0, 0], goal.bones[id] ?? [0, 0, 0], alpha)]),
  )
  return {
    x: lerp(previous.x, goal.x, alpha),
    y: lerp(previous.y, goal.y, alpha),
    scale: lerp(previous.scale, goal.scale, alpha * 0.5),
    bones,
    armsUp: target.armsUp,
    visible: target.visible,
  }
}

export interface ReactionState {
  readonly armsUpHeld: boolean
  readonly lastY: number
  readonly hoorays: number
  readonly jumps: number
  readonly cooldownSec: number
}

export const INITIAL_REACTIONS: ReactionState = { armsUpHeld: false, lastY: 0.5, hoorays: 0, jumps: 0, cooldownSec: 0 }

export interface ReactionEvents {
  readonly hooray: boolean
  readonly jump: boolean
}

/** A jump is a fast upward torso move; a hooray is both wrists rising above the nose. */
export const JUMP_VELOCITY = 0.9
const REACTION_COOLDOWN_SEC = 1.2

export const detectReactions = (
  state: ReactionState,
  pose: PuppetPose,
  dtSec: number,
): { readonly state: ReactionState; readonly events: ReactionEvents } => {
  const cooldownSec = Math.max(0, state.cooldownSec - dtSec)
  const velocity = dtSec > 0 ? (pose.y - state.lastY) / dtSec : 0
  const jump = pose.visible && cooldownSec === 0 && velocity > JUMP_VELOCITY
  const hooray = pose.visible && pose.armsUp && !state.armsUpHeld && cooldownSec === 0
  return {
    state: {
      armsUpHeld: pose.armsUp,
      lastY: pose.y,
      hoorays: state.hoorays + (hooray ? 1 : 0),
      jumps: state.jumps + (jump ? 1 : 0),
      cooldownSec: hooray || jump ? REACTION_COOLDOWN_SEC : cooldownSec,
    },
    events: { hooray, jump },
  }
}

/** Landmark pairs to draw when the tracking skeleton overlay is on. */
export const SKELETON_LINKS: readonly (readonly [number, number])[] = [
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER], [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW], [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW], [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST], [POSE.LEFT_SHOULDER, POSE.LEFT_HIP],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP], [POSE.LEFT_HIP, POSE.RIGHT_HIP], [POSE.LEFT_HIP, POSE.LEFT_KNEE], [POSE.LEFT_KNEE, POSE.LEFT_ANKLE],
  [POSE.RIGHT_HIP, POSE.RIGHT_KNEE], [POSE.RIGHT_KNEE, POSE.RIGHT_ANKLE], [POSE.NOSE, POSE.LEFT_SHOULDER], [POSE.NOSE, POSE.RIGHT_SHOULDER],
]
