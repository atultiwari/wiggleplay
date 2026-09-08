import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GameMeta } from '../../config/games'
import { SESSION } from '../../config/site'
import { playCheer, unlockAudio } from '../../lib/audio/sfx'
import { primeVoices, say, stopSpeaking } from '../../lib/audio/voice'
import { useCamera } from '../../lib/camera/useCamera'
import { useElementSize } from '../../lib/game/canvas'
import { useHandTracking } from '../../lib/hands/useHandTracking'
import { HoldButton } from './HoldButton'
import { BreakOverlay, IntroOverlay, LoadingOverlay } from './Overlays'
import type { GameRenderer, GameStage } from './types'
import './GameShell.css'

type Phase = 'intro' | 'starting' | 'playing' | 'break'

export interface GameShellProps {
  readonly game: GameMeta
  /** How visible the camera feed is behind the game, 0..1. */
  readonly cameraOpacity?: number
  readonly children: GameRenderer
}

const NO_HANDS_HINT_MS = 2500
const HINT_POLL_MS = 400

const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    console.warn('[shell] fullscreen unavailable', error)
  }
}

/**
 * Owns the camera, hand tracking, session phases and the parent gate.
 * Games only receive a canvas plus the latest hands.
 */
export const GameShell = ({ game, cameraOpacity = 1, children }: GameShellProps) => {
  const navigate = useNavigate()
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(stageRef)
  const [requestedPhase, setRequestedPhase] = useState<Phase>('intro')
  const [showHint, setShowHint] = useState(false)
  const announcedRef = useRef(false)

  const devicesEnabled = requestedPhase !== 'intro'
  const camera = useCamera(videoRef, devicesEnabled)
  const tracking = useHandTracking({
    videoRef,
    enabled: devicesEnabled && camera.status === 'ready',
    width: size.width,
    height: size.height,
  })
  const ready = camera.status === 'ready' && tracking.status === 'ready'
  const phase: Phase = requestedPhase === 'starting' && ready ? 'playing' : requestedPhase

  useEffect(() => {
    if (phase === 'playing' && !announcedRef.current) {
      announcedRef.current = true
      say(game.howTo)
    }
    if (phase === 'intro') announcedRef.current = false
  }, [phase, game.howTo])

  useEffect(() => {
    if (phase !== 'playing') return
    const timer = setTimeout(() => {
      setRequestedPhase('break')
      playCheer()
      say('Great playing! Time for a little break. Bye bye!')
    }, SESSION.suggestedMinutes * 60_000)
    return () => clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (phase !== 'playing') return
    let lastSeen = performance.now()
    const poll = setInterval(() => {
      if (tracking.handsRef.current.length > 0) lastSeen = performance.now()
      setShowHint(performance.now() - lastSeen > NO_HANDS_HINT_MS)
    }, HINT_POLL_MS)
    return () => {
      clearInterval(poll)
      setShowHint(false)
    }
  }, [phase, tracking.handsRef])

  const start = async () => {
    await unlockAudio()
    primeVoices()
    setRequestedPhase('starting')
  }

  const exit = () => {
    stopSpeaking()
    navigate('/')
  }

  const retry = () => setRequestedPhase('intro')

  const stage: GameStage = {
    canvasRef,
    handsRef: tracking.handsRef,
    size,
    active: phase === 'playing',
  }

  return (
    <div className="shell" style={{ '--accent': game.accent } as CSSProperties}>
      <div ref={stageRef} className="shell__stage">
        <video ref={videoRef} className="shell__video" style={{ opacity: cameraOpacity }} playsInline muted autoPlay />
        <canvas ref={canvasRef} className="shell__canvas" aria-label={`${game.title} play area`} />
        {children(stage)}
        {showHint && phase === 'playing' && <div className="shell__hint">👋 Show me your hand!</div>}
      </div>

      <div className="shell__topbar">
        <HoldButton label="Hold to exit" icon="🏠" onHold={exit} />
        <span className="shell__title">
          {game.emoji} {game.title}
        </span>
        <button type="button" className="shell__iconbtn" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
          ⛶
        </button>
      </div>

      {phase === 'intro' && <IntroOverlay game={game} onStart={start} onExit={exit} />}
      {phase === 'starting' && (
        <LoadingOverlay
          camera={camera}
          trackerStatus={tracking.status}
          trackerError={tracking.error}
          onRetry={retry}
          onExit={exit}
        />
      )}
      {phase === 'break' && <BreakOverlay onMore={() => setRequestedPhase('playing')} onExit={exit} />}
    </div>
  )
}
