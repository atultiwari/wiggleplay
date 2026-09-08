import type { ReactNode, RefObject } from 'react'
import type { HandPose } from '../../types/hand'
import type { Size } from '../../lib/game/canvas'

/** Everything a game needs from the shell to run its own loop. */
export interface GameStage {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly handsRef: RefObject<readonly HandPose[]>
  readonly size: Size
  /** False while paused (intro, loading, break). Games should freeze but keep drawing. */
  readonly active: boolean
}

export interface GameProps {
  readonly stage: GameStage
}

export type GameRenderer = (stage: GameStage) => ReactNode
