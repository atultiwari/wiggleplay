import { useEffect, useRef } from 'react'

export type FrameCallback = (dtSec: number, nowMs: number) => void

/** Largest step we allow, so a background tab does not "teleport" objects. */
const MAX_DT_SEC = 0.05

/** requestAnimationFrame loop with a clamped delta time. The callback may change freely. */
export const useGameLoop = (onFrame: FrameCallback, active: boolean): void => {
  const callbackRef = useRef<FrameCallback>(onFrame)
  useEffect(() => {
    callbackRef.current = onFrame
  }, [onFrame])

  useEffect(() => {
    if (!active) return
    let handle = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dtSec = Math.min(MAX_DT_SEC, (now - last) / 1000)
      last = now
      try {
        callbackRef.current(dtSec, now)
      } catch (error) {
        console.error('[game-loop] frame failed', error)
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [active])
}
