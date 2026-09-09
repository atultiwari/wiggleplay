import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { ART } from '../../assets/art'
import type { GameMeta } from '../../config/games'
import { playCheer, unlockAudio } from '../../lib/audio/sfx'
import { primeVoices, say, stopSpeaking } from '../../lib/audio/voice'
import { useElementSize, type Size } from '../../lib/game/canvas'
import type { Point } from '../../lib/math/vec'
import { useMicrophoneLevel, type MicLevel, type MicState } from '../../lib/sensors/useMicrophoneLevel'
import { requestMotionPermission, useShake, type ShakeSample } from '../../lib/sensors/useShake'
import { useSettings } from '../../lib/settings/context'
import { SettingsPanel } from '../settings/SettingsPanel'
import { HoldButton } from './HoldButton'
import { BreakOverlay } from './Overlays'
import './GameShell.css'
import './ActivityShell.css'

export type ActivitySensor = 'microphone' | 'motion'

/** A finger (or mouse) currently touching the stage, in canvas pixels. */
export interface Touch extends Point {
  readonly id: number
  readonly velocity: Point
}

/** Everything a touch / voice / motion game needs from the shell. */
export interface ActivityStage {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly size: Size
  readonly active: boolean
  /** Fingers currently down. */
  readonly touchesRef: RefObject<readonly Touch[]>
  /** Taps that happened since the game last asked; calling this clears them. */
  readonly takeTaps: () => readonly Point[]
  readonly micRef: RefObject<MicLevel>
  readonly shakeRef: RefObject<ShakeSample>
}

export interface ActivityShellProps {
  readonly game: GameMeta
  readonly sensor?: ActivitySensor
  readonly children: (stage: ActivityStage) => ReactNode
}

type Phase = 'intro' | 'playing' | 'break'

const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    console.warn('[shell] fullscreen unavailable', error)
  }
}

const SENSOR_NOTE: Readonly<Record<ActivitySensor, string>> = {
  microphone: 'Grown-ups: the microphone only measures how loud the room is. Nothing is recorded or uploaded.',
  motion: 'Grown-ups: this game uses the tablet’s motion sensor. On a laptop you can drag the tree instead.',
}

const IntroCard = ({ game, sensor, onStart, onExit }: { readonly game: GameMeta; readonly sensor?: ActivitySensor; readonly onStart: () => void; readonly onExit: () => void }) => (
  <div className="overlay" role="dialog" aria-labelledby="intro-title">
    <img className="overlay__mascot" src={ART.mascot} alt="" width={160} height={160} />
    <h1 id="intro-title" className="overlay__title">
      {game.emoji} {game.title}
    </h1>
    <p className="overlay__text">{game.howTo}</p>
    <button type="button" className="btn btn--big" onClick={onStart} autoFocus>
      ▶ Play
    </button>
    <p className="overlay__note">{sensor ? SENSOR_NOTE[sensor] : 'Grown-ups: big targets, no wrong answers, and nothing leaves this device.'}</p>
    <HoldButton label="Hold to go home" icon="🏠" onHold={onExit} className="overlay__exit" />
  </div>
)

const MicOverlay = ({ mic, onRetry, onExit }: { readonly mic: MicState; readonly onRetry: () => void; readonly onExit: () => void }) => (
  <div className="overlay" role="status" aria-live="polite">
    <img className={`overlay__mascot ${mic.error ? '' : 'overlay__mascot--bounce'}`} src={ART.mascot} alt="" width={140} height={140} />
    {mic.error ? (
      <>
        <h2 className="overlay__title">Oops!</h2>
        <p className="overlay__text">{mic.error}</p>
        <div className="overlay__actions">
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn btn--ghost" onClick={onExit}>
            Back home
          </button>
        </div>
      </>
    ) : (
      <p className="overlay__text overlay__text--big">Asking for the microphone…</p>
    )}
  </div>
)

/**
 * Owns the session phases, the parent gate, settings and the touch / microphone / motion inputs
 * for games that do not use the camera. Games receive a canvas plus refs they read in their loop.
 */
export const ActivityShell = ({ game, sensor, children }: ActivityShellProps) => {
  const navigate = useNavigate()
  const { settings } = useSettings()
  const global = settings.global
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(stageRef)
  const [phase, setPhase] = useState<Phase>('intro')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [motionDenied, setMotionDenied] = useState(false)
  const touchesRef = useRef<readonly Touch[]>([])
  const tapsRef = useRef<readonly Point[]>([])
  const lastMoveRef = useRef<Map<number, { x: number; y: number; at: number }>>(new Map())
  const announcedRef = useRef(false)

  const sensorsOn = phase !== 'intro'
  const { state: mic, levelRef: micRef } = useMicrophoneLevel(sensorsOn && sensor === 'microphone')
  const shakeRef = useShake(sensorsOn && sensor === 'motion')
  const micReady = sensor !== 'microphone' || mic.status === 'ready'
  const active = phase === 'playing' && micReady && !settingsOpen

  useEffect(() => {
    if (active && !announcedRef.current) {
      announcedRef.current = true
      say(game.howTo)
    }
    if (phase === 'intro') announcedRef.current = false
  }, [active, phase, game.howTo])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      setPhase('break')
      playCheer()
      say('Great playing! Time for a little break. Bye bye!')
    }, global.sessionMinutes * 60_000)
    return () => clearTimeout(timer)
  }, [active, global.sessionMinutes])

  const start = async () => {
    await unlockAudio()
    primeVoices()
    if (sensor === 'motion') setMotionDenied(!(await requestMotionPermission()))
    setPhase('playing')
  }

  // Laptops have no motion sensor: after a moment without any motion event, tell the child to drag instead.
  useEffect(() => {
    if (!active || sensor !== 'motion') return
    const timer = setTimeout(() => setMotionDenied((denied) => denied || !shakeRef.current.supported), 2500)
    return () => clearTimeout(timer)
  }, [active, sensor, shakeRef])

  const exit = () => {
    stopSpeaking()
    navigate('/')
  }

  const local = (event: ReactPointerEvent<HTMLElement>): Point => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active) return
    const point = local(event)
    lastMoveRef.current.set(event.pointerId, { ...point, at: event.timeStamp })
    touchesRef.current = [...touchesRef.current.filter((t) => t.id !== event.pointerId), { id: event.pointerId, ...point, velocity: { x: 0, y: 0 } }]
    tapsRef.current = [...tapsRef.current, point]
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = lastMoveRef.current.get(event.pointerId)
    if (!previous) return
    const point = local(event)
    const now = event.timeStamp
    const dt = Math.max(0.001, (now - previous.at) / 1000)
    const velocity = { x: (point.x - previous.x) / dt, y: (point.y - previous.y) / dt }
    lastMoveRef.current.set(event.pointerId, { ...point, at: now })
    touchesRef.current = touchesRef.current.map((t) => (t.id === event.pointerId ? { ...t, ...point, velocity } : t))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastMoveRef.current.delete(event.pointerId)
    touchesRef.current = touchesRef.current.filter((t) => t.id !== event.pointerId)
  }

  const takeTaps = useCallback((): readonly Point[] => {
    const taps = tapsRef.current
    tapsRef.current = []
    return taps
  }, [])

  const stage: ActivityStage = { canvasRef, size, active, touchesRef, takeTaps, micRef, shakeRef }

  return (
    <div className="shell shell--activity" style={{ '--accent': game.accent } as CSSProperties}>
      <div ref={stageRef} className="shell__stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerUp}>
        <canvas ref={canvasRef} className="shell__canvas" aria-label={`${game.title} play area`} />
        {children(stage)}
        {sensor === 'motion' && motionDenied && active && <div className="shell__hint">📱 Motion is off, drag the tree instead!</div>}
      </div>

      <div className="shell__topbar">
        <HoldButton label="Hold to exit" icon="🏠" onHold={exit} />
        <HoldButton label="Hold for settings" icon="⚙️" holdMs={1000} onHold={() => setSettingsOpen(true)} />
        <span className="shell__title">
          {game.emoji} {game.title}
        </span>
        <button type="button" className="shell__iconbtn" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
          ⛶
        </button>
      </div>

      {phase === 'intro' && <IntroCard game={game} sensor={sensor} onStart={start} onExit={exit} />}
      {phase === 'playing' && sensor === 'microphone' && mic.status !== 'ready' && <MicOverlay mic={mic} onRetry={() => setPhase('intro')} onExit={exit} />}
      {phase === 'break' && <BreakOverlay onMore={() => setPhase('playing')} onExit={exit} />}
      {settingsOpen && <SettingsPanel gameId={game.id} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
