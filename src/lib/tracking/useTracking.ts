import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Pointer } from '../../types/pointer'
import { HandTracker } from '../hands/HandTracker'
import { buildHandPoses } from '../hands/poses'
import { PoseTracker } from '../pose/PoseTracker'
import { ALL_POINTER_KINDS, buildPosePointers } from '../pose/posePointers'
import { modeInfo, type InteractionMode } from './modes'

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface TrackingOptions {
  readonly videoRef: RefObject<HTMLVideoElement | null>
  readonly enabled: boolean
  readonly width: number
  readonly height: number
  readonly mode: InteractionMode
  readonly mirrored?: boolean
  /** Hand modes only. Changing this restarts the tracker. */
  readonly numHands?: number
  /** 0..1 minimum smoothing share; applied live. */
  readonly smoothing?: number
  /** Seconds of motion prediction; applied live. */
  readonly predictionSec?: number
}

export interface TrackingState {
  /** Always the latest pointers; read inside the game loop, never triggers re-render. */
  readonly pointersRef: RefObject<readonly Pointer[]>
  readonly status: TrackerStatus
  readonly error: string | null
  readonly fps: number
}

const BASE = import.meta.env.BASE_URL
export const WASM_BASE_PATH = `${BASE}mediapipe/wasm`
export const HAND_MODEL_PATH = `${BASE}models/hand_landmarker.task`
export const POSE_MODEL_PATH = `${BASE}models/pose_landmarker_lite.task`

interface Detector {
  readonly detect: (video: HTMLVideoElement, now: number, previous: readonly Pointer[], live: LiveOptions) => readonly Pointer[]
  readonly close: () => void
}

interface LiveOptions {
  readonly width: number
  readonly height: number
  readonly smoothing: number
  readonly predictionSec: number
}

const createDetector = async (mode: InteractionMode, numHands: number, mirrored: boolean): Promise<Detector> => {
  if (modeInfo(mode).model === 'pose') {
    const tracker = await PoseTracker.create({ wasmBasePath: WASM_BASE_PATH, modelPath: POSE_MODEL_PATH })
    const include = mode === 'head' ? (['head'] as const) : ALL_POINTER_KINDS
    let lastAt = performance.now()
    return {
      detect: (video, now, previous, live) => {
        const landmarks = tracker.detect(video, Math.round(now))
        const pointers = buildPosePointers({
          previous,
          landmarks,
          width: live.width,
          height: live.height,
          mirrored,
          dtMs: now - lastAt,
          smoothing: live.smoothing,
          predictionSec: live.predictionSec,
          include,
        })
        lastAt = now
        return pointers
      },
      close: () => tracker.close(),
    }
  }
  const tracker = await HandTracker.create({ wasmBasePath: WASM_BASE_PATH, modelPath: HAND_MODEL_PATH, numHands })
  let nextId = 1
  let lastAt = performance.now()
  return {
    detect: (video, now, previous, live) => {
      const detected = tracker.detect(video, Math.round(now))
      const result = buildHandPoses({
        previous,
        detected,
        width: live.width,
        height: live.height,
        mirrored,
        dtMs: now - lastAt,
        smoothing: live.smoothing,
        predictionSec: live.predictionSec,
        cursor: mode === 'finger' ? 'tip' : 'palm',
        nextId,
      })
      nextId = result.nextId
      lastAt = now
      return result.hands
    },
    close: () => tracker.close(),
  }
}

/** Runs the tracker for the chosen interaction mode on every new video frame. */
export const useTracking = (options: TrackingOptions): TrackingState => {
  const { videoRef, enabled, width, height, mode, mirrored = true, numHands = 2, smoothing = 0.6, predictionSec = 0 } = options
  const pointersRef = useRef<readonly Pointer[]>([])
  const liveRef = useRef<LiveOptions>({ width, height, smoothing, predictionSec })
  const [outcome, setOutcome] = useState<Exclude<TrackerStatus, 'loading'>>('idle')
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    liveRef.current = { width, height, smoothing, predictionSec }
  }, [width, height, smoothing, predictionSec])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let detector: Detector | null = null
    let frameHandle = 0
    let lastVideoTime = -1
    let frameCount = 0
    let fpsWindowStart = performance.now()

    const loop = () => {
      if (cancelled || !detector) return
      const video = videoRef.current
      const now = performance.now()
      if (video && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        try {
          pointersRef.current = detector.detect(video, now, pointersRef.current, liveRef.current)
          frameCount += 1
          if (now - fpsWindowStart >= 1000) {
            setFps(Math.round((frameCount * 1000) / (now - fpsWindowStart)))
            frameCount = 0
            fpsWindowStart = now
          }
        } catch (detectError) {
          console.warn('[tracking] detect failed', detectError)
        }
      }
      frameHandle = requestAnimationFrame(loop)
    }

    createDetector(mode, numHands, mirrored)
      .then((created) => {
        if (cancelled) {
          created.close()
          return
        }
        detector = created
        setOutcome('ready')
        frameHandle = requestAnimationFrame(loop)
      })
      .catch((createError: unknown) => {
        if (cancelled) return
        console.error('[tracking] failed to load model', createError)
        setOutcome('error')
        setError('Tracking could not start. Try a newer browser such as Chrome or Edge.')
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frameHandle)
      detector?.close()
      pointersRef.current = []
      setOutcome('idle')
      setError(null)
      setFps(0)
    }
  }, [enabled, mode, mirrored, numHands, videoRef])

  const status: TrackerStatus = enabled && outcome === 'idle' ? 'loading' : outcome
  return { pointersRef, status, error, fps }
}
