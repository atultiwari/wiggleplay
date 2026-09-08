import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { Point } from '../math/vec'

export interface HandTrackerOptions {
  readonly wasmBasePath: string
  readonly modelPath: string
  readonly numHands?: number
}

/** Thin wrapper around MediaPipe's HandLandmarker in VIDEO mode. */
export class HandTracker {
  private lastTimestamp = -1
  private readonly landmarker: HandLandmarker

  private constructor(landmarker: HandLandmarker) {
    this.landmarker = landmarker
  }

  static async create(options: HandTrackerOptions): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(options.wasmBasePath)
    const baseOptions = { modelAssetPath: options.modelPath }
    const shared = { runningMode: 'VIDEO' as const, numHands: options.numHands ?? 2 }
    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: 'GPU' },
        ...shared,
      })
      return new HandTracker(landmarker)
    } catch (error) {
      console.warn('[hands] GPU delegate failed, falling back to CPU', error)
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: 'CPU' },
        ...shared,
      })
      return new HandTracker(landmarker)
    }
  }

  /** Returns normalised (0..1) landmarks per detected hand. Skips duplicate timestamps. */
  detect(video: HTMLVideoElement, timestampMs: number): readonly (readonly Point[])[] {
    if (timestampMs <= this.lastTimestamp) return []
    this.lastTimestamp = timestampMs
    const result = this.landmarker.detectForVideo(video, timestampMs)
    return result.landmarks.map((hand) => hand.map((l) => ({ x: l.x, y: l.y })))
  }

  close(): void {
    this.landmarker.close()
  }
}
