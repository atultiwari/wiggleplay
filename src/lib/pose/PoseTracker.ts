import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Point } from '../math/vec'

export interface PoseLandmark extends Point {
  /** 0..1 confidence that the joint is actually visible. */
  readonly visibility: number
}

export interface PoseTrackerOptions {
  readonly wasmBasePath: string
  readonly modelPath: string
}

/** Thin wrapper around MediaPipe's PoseLandmarker (one person) in VIDEO mode. */
export class PoseTracker {
  private lastTimestamp = -1
  private readonly landmarker: PoseLandmarker

  private constructor(landmarker: PoseLandmarker) {
    this.landmarker = landmarker
  }

  static async create(options: PoseTrackerOptions): Promise<PoseTracker> {
    const fileset = await FilesetResolver.forVisionTasks(options.wasmBasePath)
    const shared = { runningMode: 'VIDEO' as const, numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }
    try {
      const landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: options.modelPath, delegate: 'GPU' },
        ...shared,
      })
      return new PoseTracker(landmarker)
    } catch (error) {
      console.warn('[pose] GPU delegate failed, falling back to CPU', error)
      const landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: options.modelPath, delegate: 'CPU' },
        ...shared,
      })
      return new PoseTracker(landmarker)
    }
  }

  /** Returns the 33 normalised landmarks of the first person, or undefined. */
  detect(video: HTMLVideoElement, timestampMs: number): readonly PoseLandmark[] | undefined {
    if (timestampMs <= this.lastTimestamp) return undefined
    this.lastTimestamp = timestampMs
    const result = this.landmarker.detectForVideo(video, timestampMs)
    const person = result.landmarks[0]
    return person?.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility ?? 1 }))
  }

  close(): void {
    this.landmarker.close()
  }
}
