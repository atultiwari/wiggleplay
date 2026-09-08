import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import './HoldButton.css'

export interface HoldButtonProps {
  readonly label: string
  readonly icon: string
  readonly onHold: () => void
  /** How long the button must be held. Long enough that a toddler will not do it by accident. */
  readonly holdMs?: number
  readonly className?: string
}

const TICK_MS = 50

/** A "parent gate" button: fires only after being pressed and held. */
export const HoldButton = ({ label, icon, onHold, holdMs = 1500, className = '' }: HoldButtonProps) => {
  const [progress, setProgress] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onHoldRef = useRef(onHold)
  useEffect(() => {
    onHoldRef.current = onHold
  }, [onHold])

  const stop = () => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    setProgress(0)
  }

  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (intervalRef.current) return
    let elapsed = 0
    intervalRef.current = setInterval(() => {
      elapsed += TICK_MS
      const next = Math.min(1, elapsed / holdMs)
      setProgress(next)
      if (next >= 1) {
        stop()
        onHoldRef.current()
      }
    }, TICK_MS)
  }

  useEffect(() => stop, [])

  return (
    <button
      type="button"
      className={`hold-btn ${className}`}
      style={{ '--progress': progress } as CSSProperties}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={label}
      title={label}
    >
      <span className="hold-btn__ring" aria-hidden="true" />
      <span className="hold-btn__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="hold-btn__label">{label}</span>
    </button>
  )
}
