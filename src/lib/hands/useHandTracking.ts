import { useEffect, useRef, useState, type RefObject } from 'react'
import type { HandPose } from '../../types/hand'
import { HandTracker } from './HandTracker'
import { buildHandPoses } from './poses'

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface HandTrackingOptions {
  readonly videoRef: RefObject<HTMLVideoElement | null>
  readonly enabled: boolean
  readonly width: number
  readonly height: number
  readonly mirrored?: boolean
  /** Changing this restarts the tracker. */
  readonly numHands?: number
  /** 0..1 minimum smoothing share; applied live. */
  readonly smoothing?: number
  /** Seconds of motion prediction; applied live. */
  readonly predictionSec?: number
}

export interface HandTrackingState {
  /** Always the latest hands; read inside the game loop, never triggers re-render. */
  readonly handsRef: RefObject<readonly HandPose[]>
  readonly status: TrackerStatus
  readonly error: string | null
  readonly fps: number
}

const BASE = import.meta.env.BASE_URL
export const WASM_BASE_PATH = `${BASE}mediapipe/wasm`
export const HAND_MODEL_PATH = `${BASE}models/hand_landmarker.task`

/** Runs hand detection on every new video frame and exposes smoothed HandPose objects. */
export const useHandTracking = (options: HandTrackingOptions): HandTrackingState => {
  const { videoRef, enabled, width, height, mirrored = true, numHands = 2, smoothing = 0.6, predictionSec = 0 } = options
  const handsRef = useRef<readonly HandPose[]>([])
  const liveRef = useRef({ width, height, smoothing, predictionSec })
  const [outcome, setOutcome] = useState<Exclude<TrackerStatus, 'loading'>>('idle')
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    liveRef.current = { width, height, smoothing, predictionSec }
  }, [width, height, smoothing, predictionSec])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let tracker: HandTracker | null = null
    let frameHandle = 0
    let nextId = 1
    let lastFrameAt = performance.now()
    let lastVideoTime = -1
    let frameCount = 0
    let fpsWindowStart = performance.now()

    const loop = () => {
      if (cancelled || !tracker) return
      const video = videoRef.current
      const now = performance.now()
      if (video && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        try {
          const detected = tracker.detect(video, Math.round(now))
          const live = liveRef.current
          const result = buildHandPoses({
            previous: handsRef.current,
            detected,
            width: live.width,
            height: live.height,
            mirrored,
            dtMs: now - lastFrameAt,
            smoothing: live.smoothing,
            predictionSec: live.predictionSec,
            nextId,
          })
          nextId = result.nextId
          handsRef.current = result.hands
          lastFrameAt = now
          frameCount += 1
          if (now - fpsWindowStart >= 1000) {
            setFps(Math.round((frameCount * 1000) / (now - fpsWindowStart)))
            frameCount = 0
            fpsWindowStart = now
          }
        } catch (detectError) {
          console.warn('[hands] detect failed', detectError)
        }
      }
      frameHandle = requestAnimationFrame(loop)
    }

    HandTracker.create({ wasmBasePath: WASM_BASE_PATH, modelPath: HAND_MODEL_PATH, numHands })
      .then((created) => {
        if (cancelled) {
          created.close()
          return
        }
        tracker = created
        setOutcome('ready')
        frameHandle = requestAnimationFrame(loop)
      })
      .catch((createError: unknown) => {
        if (cancelled) return
        console.error('[hands] failed to load model', createError)
        setOutcome('error')
        setError('Hand tracking could not start. Try a newer browser such as Chrome or Safari.')
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frameHandle)
      tracker?.close()
      handsRef.current = []
      setOutcome('idle')
      setError(null)
      setFps(0)
    }
  }, [enabled, mirrored, numHands, videoRef])

  const status: TrackerStatus = enabled && outcome === 'idle' ? 'loading' : outcome
  return { handsRef, status, error, fps }
}
