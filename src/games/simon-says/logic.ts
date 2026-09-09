import { pickOne, type Rng } from '../../lib/game/random'
import type { Point } from '../../lib/math/vec'
import { distance } from '../../lib/math/vec'
import { POSE } from '../../lib/pose/posePointers'
import type { PoseLandmark } from '../../lib/pose/PoseTracker'
import type { SimonSaysSettings } from '../../lib/settings/schema'

export type Move = 'hands-up' | 'touch-nose' | 'touch-head' | 'clap' | 'wave' | 'touch-tummy' | 'jump' | 'one-foot'

export interface MoveInfo {
  readonly label: string
  readonly emoji: string
  readonly say: string
  readonly praise: string
}

export const MOVE_INFO: Readonly<Record<Move, MoveInfo>> = {
  'hands-up': { label: 'Hands up!', emoji: '🙌', say: 'Simon says: put your hands up high!', praise: 'Hands up! Wonderful!' },
  'touch-nose': { label: 'Touch your nose!', emoji: '👃', say: 'Simon says: touch your nose!', praise: 'You found your nose!' },
  'touch-head': { label: 'Touch your head!', emoji: '🙆', say: 'Simon says: touch your head!', praise: 'That is your head! Great!' },
  clap: { label: 'Clap your hands!', emoji: '👏', say: 'Simon says: clap your hands!', praise: 'Clap clap! Lovely!' },
  wave: { label: 'Wave hello!', emoji: '👋', say: 'Simon says: wave hello!', praise: 'Hello to you too!' },
  'touch-tummy': { label: 'Touch your tummy!', emoji: '🫃', say: 'Simon says: touch your tummy!', praise: 'That is your tummy!' },
  jump: { label: 'Jump!', emoji: '🦘', say: 'Simon says: jump!', praise: 'Boing! What a jump!' },
  'one-foot': { label: 'Stand on one foot!', emoji: '🦩', say: 'Simon says: stand on one foot like a flamingo!', praise: 'A flamingo! Amazing!' },
}

export const EASY_MOVES: readonly Move[] = ['hands-up', 'touch-nose', 'touch-head', 'clap', 'wave', 'touch-tummy']
export const HARD_MOVES: readonly Move[] = ['jump', 'one-foot']

/** The body parts a move needs, in normalised image coordinates (y grows downward). */
export interface BodyFrame {
  readonly visible: boolean
  readonly nose: Point
  readonly eyeY: number
  readonly leftWrist: Point | null
  readonly rightWrist: Point | null
  readonly leftAnkle: Point | null
  readonly rightAnkle: Point | null
  readonly shoulderY: number
  readonly hips: Point
  readonly shoulderWidth: number
  readonly torsoHeight: number
  /** Torso centre height, used for jumps. */
  readonly torsoY: number
}

export const EMPTY_FRAME: BodyFrame = {
  visible: false,
  nose: { x: 0.5, y: 0.3 },
  eyeY: 0.28,
  leftWrist: null,
  rightWrist: null,
  leftAnkle: null,
  rightAnkle: null,
  shoulderY: 0.45,
  hips: { x: 0.5, y: 0.7 },
  shoulderWidth: 0.2,
  torsoHeight: 0.25,
  torsoY: 0.55,
}

const MIN_VISIBILITY = 0.5

export const frameFromLandmarks = (landmarks: readonly PoseLandmark[] | null): BodyFrame => {
  if (!landmarks || landmarks.length < 33) return EMPTY_FRAME
  const ok = (i: number) => landmarks[i].visibility >= MIN_VISIBILITY
  const at = (i: number): Point => ({ x: landmarks[i].x, y: landmarks[i].y })
  const maybe = (i: number): Point | null => (ok(i) ? at(i) : null)
  if (!ok(POSE.LEFT_SHOULDER) || !ok(POSE.RIGHT_SHOULDER) || !ok(POSE.NOSE)) return EMPTY_FRAME
  const ls = at(POSE.LEFT_SHOULDER)
  const rs = at(POSE.RIGHT_SHOULDER)
  const shoulders = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }
  const shoulderWidth = Math.max(0.05, Math.abs(ls.x - rs.x))
  const hips = ok(POSE.LEFT_HIP) && ok(POSE.RIGHT_HIP) ? { x: (landmarks[POSE.LEFT_HIP].x + landmarks[POSE.RIGHT_HIP].x) / 2, y: (landmarks[POSE.LEFT_HIP].y + landmarks[POSE.RIGHT_HIP].y) / 2 } : { x: shoulders.x, y: shoulders.y + shoulderWidth * 1.3 }
  const eyeY = ok(POSE.LEFT_EYE) && ok(POSE.RIGHT_EYE) ? (landmarks[POSE.LEFT_EYE].y + landmarks[POSE.RIGHT_EYE].y) / 2 : at(POSE.NOSE).y - shoulderWidth * 0.15
  return {
    visible: true,
    nose: at(POSE.NOSE),
    eyeY,
    leftWrist: maybe(POSE.LEFT_WRIST),
    rightWrist: maybe(POSE.RIGHT_WRIST),
    leftAnkle: maybe(POSE.LEFT_ANKLE),
    rightAnkle: maybe(POSE.RIGHT_ANKLE),
    shoulderY: shoulders.y,
    hips,
    shoulderWidth,
    torsoHeight: Math.max(0.05, hips.y - shoulders.y),
    torsoY: (shoulders.y + hips.y) / 2,
  }
}

const wrists = (frame: BodyFrame): readonly Point[] => [frame.leftWrist, frame.rightWrist].filter((w): w is Point => w !== null)

/** Whether a still pose matches a move; jumping and waving need motion and are judged in stepSimon. */
export const poseMatches = (move: Move, frame: BodyFrame): boolean => {
  if (!frame.visible) return false
  const w = frame.shoulderWidth
  const hands = wrists(frame)
  switch (move) {
    case 'hands-up':
      return !!frame.leftWrist && !!frame.rightWrist && frame.leftWrist.y < frame.nose.y && frame.rightWrist.y < frame.nose.y
    case 'touch-nose':
      return hands.some((hand) => distance(hand, frame.nose) < w * 0.6)
    case 'touch-head':
      return hands.some((hand) => hand.y < frame.eyeY - w * 0.1 && Math.abs(hand.x - frame.nose.x) < w * 1.1)
    case 'clap':
      return !!frame.leftWrist && !!frame.rightWrist && distance(frame.leftWrist, frame.rightWrist) < w * 0.5 && frame.leftWrist.y > frame.nose.y
    case 'touch-tummy':
      return hands.some((hand) => distance(hand, { x: frame.hips.x, y: frame.hips.y - frame.torsoHeight * 0.25 }) < w * 0.7)
    case 'one-foot':
      return !!frame.leftAnkle && !!frame.rightAnkle && Math.abs(frame.leftAnkle.y - frame.rightAnkle.y) > frame.torsoHeight * 0.3
    case 'wave':
    case 'jump':
      return false
  }
}

export type SimonPhase = 'asking' | 'waiting' | 'celebrating' | 'resting'

export interface SimonState {
  readonly move: Move
  readonly phase: SimonPhase
  readonly phaseSec: number
  readonly heldSec: number
  readonly done: number
  readonly asked: number
  readonly lastTorsoY: number
  /** Wave tracking: last wrist x, direction of travel and how many times it flipped recently. */
  readonly waveX: number
  readonly waveDir: number
  readonly waveFlips: number
  readonly waveSinceSec: number
}

export interface SimonConfig {
  readonly gapSec: number
  readonly harderMoves: boolean
}

export interface SimonInput {
  readonly frame: BodyFrame
  readonly config?: SimonConfig
}

export interface SimonEvents {
  readonly asked: Move | null
  readonly done: Move | null
  readonly skipped: Move | null
}

export const ASK_SEC = 2.2
export const HOLD_SEC = 0.35
export const WAIT_SEC = 12
export const CELEBRATE_SEC = 2.2
export const JUMP_VELOCITY = 0.5
export const WAVE_FLIPS = 2
export const WAVE_WINDOW_SEC = 1.6

export const DEFAULT_SIMON_CONFIG: SimonConfig = { gapSec: 4, harderMoves: false }

export const configFromSettings = (settings: SimonSaysSettings): SimonConfig => ({ gapSec: settings.gapSec, harderMoves: settings.harderMoves })

export const availableMoves = (config: SimonConfig): readonly Move[] => (config.harderMoves ? [...EASY_MOVES, ...HARD_MOVES] : EASY_MOVES)

export const pickMove = (config: SimonConfig, previous: Move | null, rng: Rng = Math.random): Move => {
  const options = availableMoves(config).filter((move) => move !== previous)
  return pickOne(options, rng)
}

export const createSimonState = (config: SimonConfig = DEFAULT_SIMON_CONFIG, rng: Rng = Math.random): SimonState => ({
  move: pickMove(config, null, rng),
  phase: 'asking',
  phaseSec: 0,
  heldSec: 0,
  done: 0,
  asked: 0,
  lastTorsoY: 0.55,
  waveX: 0.5,
  waveDir: 0,
  waveFlips: 0,
  waveSinceSec: 0,
})

/** 0..1 progress of a held pose toward counting. */
export const holdProgress = (state: SimonState): number => Math.min(1, state.heldSec / HOLD_SEC)

const trackWave = (state: SimonState, frame: BodyFrame, dtSec: number): Pick<SimonState, 'waveX' | 'waveDir' | 'waveFlips' | 'waveSinceSec'> => {
  const raised = wrists(frame).filter((hand) => hand.y < frame.shoulderY)
  const hand = raised.sort((a, b) => a.y - b.y)[0]
  if (!hand) return { waveX: state.waveX, waveDir: 0, waveFlips: 0, waveSinceSec: 0 }
  const dx = hand.x - state.waveX
  const dir = Math.abs(dx) < frame.shoulderWidth * 0.08 ? state.waveDir : Math.sign(dx)
  const flipped = dir !== 0 && state.waveDir !== 0 && dir !== state.waveDir
  const expired = state.waveSinceSec + dtSec > WAVE_WINDOW_SEC
  return {
    waveX: hand.x,
    waveDir: dir,
    waveFlips: expired ? (flipped ? 1 : 0) : state.waveFlips + (flipped ? 1 : 0),
    waveSinceSec: expired ? 0 : state.waveSinceSec + dtSec,
  }
}

export const stepSimon = (state: SimonState, dtSec: number, input: SimonInput, rng: Rng = Math.random): { readonly state: SimonState; readonly events: SimonEvents } => {
  const config = input.config ?? DEFAULT_SIMON_CONFIG
  const frame = input.frame
  const none: SimonEvents = { asked: null, done: null, skipped: null }
  const phaseSec = state.phaseSec + dtSec
  const wave = trackWave(state, frame, dtSec)
  const torsoVelocity = frame.visible && dtSec > 0 ? (state.lastTorsoY - frame.torsoY) / dtSec : 0
  const base: SimonState = { ...state, ...wave, lastTorsoY: frame.visible ? frame.torsoY : state.lastTorsoY }

  if (state.phase === 'asking') {
    if (state.phaseSec === 0) return { state: { ...base, phaseSec, asked: state.asked + 1 }, events: { ...none, asked: state.move } }
    if (phaseSec >= ASK_SEC) return { state: { ...base, phase: 'waiting', phaseSec: 0, heldSec: 0, waveFlips: 0, waveSinceSec: 0 }, events: none }
    return { state: { ...base, phaseSec }, events: none }
  }

  if (state.phase === 'waiting') {
    const instant = (state.move === 'jump' && torsoVelocity > JUMP_VELOCITY) || (state.move === 'wave' && wave.waveFlips >= WAVE_FLIPS)
    const heldSec = poseMatches(state.move, frame) ? state.heldSec + dtSec : 0
    if (instant || heldSec >= HOLD_SEC) {
      return { state: { ...base, phase: 'celebrating', phaseSec: 0, heldSec: 0, done: state.done + 1 }, events: { ...none, done: state.move } }
    }
    if (phaseSec >= WAIT_SEC) {
      return { state: { ...base, move: pickMove(config, state.move, rng), phase: 'asking', phaseSec: 0, heldSec: 0 }, events: { ...none, skipped: state.move } }
    }
    return { state: { ...base, phaseSec, heldSec }, events: none }
  }

  if (state.phase === 'celebrating') {
    if (phaseSec >= CELEBRATE_SEC) return { state: { ...base, phase: 'resting', phaseSec: 0 }, events: none }
    return { state: { ...base, phaseSec }, events: none }
  }

  if (phaseSec >= config.gapSec) {
    return { state: { ...base, move: pickMove(config, state.move, rng), phase: 'asking', phaseSec: 0 }, events: none }
  }
  return { state: { ...base, phaseSec }, events: none }
}
