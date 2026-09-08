import { useEffect, useState, type RefObject } from 'react'
import type { CameraQuality } from '../settings/schema'

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable'

export interface CameraState {
  readonly status: CameraStatus
  readonly error: string | null
}

/**
 * The hand model looks at a small image anyway, so a lower camera resolution
 * costs no accuracy but saves a lot of per-frame work on slower laptops.
 */
export const CAMERA_RESOLUTIONS: Readonly<Record<CameraQuality, { width: number; height: number }>> = {
  low: { width: 480, height: 270 },
  medium: { width: 640, height: 360 },
  high: { width: 960, height: 540 },
}

export const cameraConstraints = (quality: CameraQuality): MediaStreamConstraints => ({
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: CAMERA_RESOLUTIONS[quality].width },
    height: { ideal: CAMERA_RESOLUTIONS[quality].height },
    frameRate: { ideal: 30 },
  },
})

const describeError = (error: unknown): { status: CameraStatus; message: string } => {
  const name = error instanceof DOMException ? error.name : ''
  if (error instanceof Error && !(error instanceof DOMException)) {
    return { status: 'unavailable', message: error.message }
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { status: 'denied', message: 'Camera permission was not given. Please allow the camera and try again.' }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { status: 'unavailable', message: 'No camera was found on this device.' }
  }
  return { status: 'unavailable', message: 'The camera could not be started.' }
}

/** Starts the selfie camera into `videoRef` while `enabled` is true, and stops it on cleanup. */
export const useCamera = (
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  quality: CameraQuality = 'medium',
): CameraState => {
  const [outcome, setOutcome] = useState<CameraState>({ status: 'idle', error: null })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stream: MediaStream | null = null
    const video = videoRef.current

    const request = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia(cameraConstraints(quality))
      : Promise.reject(new Error('This browser does not support camera access.'))

    request
      .then(async (mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop())
          return
        }
        stream = mediaStream
        if (!video) throw new Error('Video element missing')
        video.srcObject = mediaStream
        await video.play()
        if (!cancelled) setOutcome({ status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const described = describeError(error)
        console.warn('[camera]', error)
        setOutcome({ status: described.status, error: described.message })
      })

    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
      if (video) video.srcObject = null
      setOutcome({ status: 'idle', error: null })
    }
  }, [enabled, quality, videoRef])

  if (enabled && outcome.status === 'idle') return { status: 'requesting', error: null }
  return outcome
}
