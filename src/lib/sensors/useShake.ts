import { useEffect, useRef, type RefObject } from 'react'

export interface ShakeSample {
  /** Acceleration magnitude without gravity, m/s², smoothed. */
  readonly magnitude: number
  /** True when the device reported at least one motion event. */
  readonly supported: boolean
}

export const STILL: ShakeSample = { magnitude: 0, supported: false }
const SMOOTHING = 0.5

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** iOS needs an explicit permission request from a user gesture; everywhere else motion just works. */
export const requestMotionPermission = async (): Promise<boolean> => {
  const api = (globalThis as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent
  if (!api?.requestPermission) return true
  try {
    return (await api.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

export const magnitudeOf = (acceleration: { x?: number | null; y?: number | null; z?: number | null } | null | undefined): number => {
  if (!acceleration) return 0
  return Math.hypot(acceleration.x ?? 0, acceleration.y ?? 0, acceleration.z ?? 0)
}

export const smoothShake = (previous: ShakeSample, magnitude: number): ShakeSample => ({
  supported: true,
  magnitude: magnitude > previous.magnitude ? magnitude : previous.magnitude + (magnitude - previous.magnitude) * SMOOTHING,
})

/** Listens to device motion while enabled and keeps the smoothed shake strength in a ref. */
export const useShake = (enabled: boolean): RefObject<ShakeSample> => {
  const shakeRef = useRef<ShakeSample>(STILL)
  useEffect(() => {
    if (!enabled) return
    const onMotion = (event: DeviceMotionEvent) => {
      shakeRef.current = smoothShake(shakeRef.current, magnitudeOf(event.acceleration))
    }
    window.addEventListener('devicemotion', onMotion)
    return () => {
      window.removeEventListener('devicemotion', onMotion)
      shakeRef.current = STILL
    }
  }, [enabled])
  return shakeRef
}
