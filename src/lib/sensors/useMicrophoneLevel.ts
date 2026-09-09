import { useEffect, useRef, useState, type RefObject } from 'react'

export type MicStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable'

export interface MicState {
  readonly status: MicStatus
  readonly error: string | null
}

export interface MicLevel {
  /** Smoothed loudness 0..1 (RMS scaled so normal talking lands around 0.3). */
  readonly level: number
  /** Instantaneous loudness 0..1. */
  readonly raw: number
}

export const SILENT: MicLevel = { level: 0, raw: 0 }
const SMOOTHING = 0.35
const RMS_SCALE = 6

const describeError = (error: unknown): { status: MicStatus; message: string } => {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { status: 'denied', message: 'Microphone permission was not given. Please allow the microphone and try again.' }
  }
  if (name === 'NotFoundError') return { status: 'unavailable', message: 'No microphone was found on this device.' }
  return { status: 'unavailable', message: 'The microphone could not be started.' }
}

/** Pure helper so the loudness mapping is testable: RMS of samples, scaled and clamped to 0..1. */
export const loudness = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.min(1, Math.sqrt(sum / samples.length) * RMS_SCALE)
}

export const smoothLevel = (previous: MicLevel, raw: number): MicLevel => ({
  raw,
  level: raw > previous.level ? raw : previous.level + (raw - previous.level) * SMOOTHING,
})

/**
 * Opens the microphone while `enabled` and keeps a smoothed loudness in `levelRef`
 * (read it from a game loop; nothing is recorded or uploaded).
 */
export const useMicrophoneLevel = (enabled: boolean): { readonly state: MicState; readonly levelRef: RefObject<MicLevel> } => {
  const [state, setState] = useState<MicState>({ status: 'idle', error: null })
  const levelRef = useRef<MicLevel>(SILENT)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    queueMicrotask(() => {
      if (!cancelled) setState({ status: 'requesting', error: null })
    })
    const request = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false }, video: false })
      : Promise.reject(new Error('Microphone access is not supported in this browser.'))
    request
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        stream = media
        context = new AudioContext()
        const source = context.createMediaStreamSource(media)
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        const tick = () => {
          analyser.getFloatTimeDomainData(samples)
          levelRef.current = smoothLevel(levelRef.current, loudness(samples))
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        setState({ status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const described = describeError(error)
        setState({ status: described.status, error: described.message })
      })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      context?.close().catch(() => undefined)
      levelRef.current = SILENT
    }
  }, [enabled])

  return { state, levelRef }
}
