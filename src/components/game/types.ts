import type { ReactNode, RefObject } from 'react'
import type { Pointer } from '../../types/pointer'
import type { PoseLandmark } from '../../lib/pose/PoseTracker'
import type { Size } from '../../lib/game/canvas'

/** Everything a game needs from the shell to run its own loop. */
export interface GameStage {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  /** Latest tracked pointers (hands, head, feet, body depending on the interaction mode). */
  readonly pointersRef: RefObject<readonly Pointer[]>
  /** Raw pose landmarks when the game runs in a pose mode (whole body / head), else null. */
  readonly poseRef: RefObject<readonly PoseLandmark[] | null>
  readonly size: Size
  /** False while paused (intro, loading, break, settings). Games should freeze but keep drawing. */
  readonly active: boolean
}

export interface GameProps {
  readonly stage: GameStage
}

export type GameRenderer = (stage: GameStage) => ReactNode
