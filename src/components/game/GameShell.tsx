import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GameMeta } from '../../config/games'
import { playCheer, unlockAudio } from '../../lib/audio/sfx'
import { primeVoices, say, stopSpeaking } from '../../lib/audio/voice'
import { useCamera } from '../../lib/camera/useCamera'
import { useElementSize } from '../../lib/game/canvas'
import { useSettings } from '../../lib/settings/context'
import { lerp } from '../../lib/math/vec'
import { modeInfo } from '../../lib/tracking/modes'
import { useTracking } from '../../lib/tracking/useTracking'
import { SettingsPanel } from '../settings/SettingsPanel'
import { HoldButton } from './HoldButton'
import { BreakOverlay, IntroOverlay, LoadingOverlay } from './Overlays'
import type { GameRenderer, GameStage } from './types'
import './GameShell.css'

type Phase = 'intro' | 'starting' | 'playing' | 'break'

export interface GameShellProps {
  readonly game: GameMeta
  readonly children: GameRenderer
}

const NO_POINTER_HINT_MS = 2500
const HINT_POLL_MS = 400
/** Responsiveness 0..1 maps to this minimum smoothing share. */
const SMOOTHING_RANGE = [0.22, 0.92] as const
/** Responsiveness 0..1 maps to this much motion prediction (seconds). */
const PREDICTION_RANGE = [0, 0.07] as const

const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    console.warn('[shell] fullscreen unavailable', error)
  }
}

/**
 * Owns the camera, tracking, session phases, settings and the parent gate.
 * Games only receive a canvas plus the latest pointers.
 */
export const GameShell = ({ game, children }: GameShellProps) => {
  const navigate = useNavigate()
  const { settings, updateGlobal } = useSettings()
  const global = settings.global
  const mode = modeInfo(game.requiresPose ? 'body' : global.interaction)
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(stageRef)
  const [requestedPhase, setRequestedPhase] = useState<Phase>('intro')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const announcedRef = useRef(false)

  const devicesEnabled = requestedPhase !== 'intro'
  const camera = useCamera(videoRef, devicesEnabled, global.cameraQuality)
  const numHands = global.handsTracked === 'auto' ? game.hands : global.handsTracked
  const tracking = useTracking({
    videoRef,
    enabled: devicesEnabled && camera.status === 'ready',
    width: size.width,
    height: size.height,
    mode: mode.id,
    numHands,
    smoothing: lerp(SMOOTHING_RANGE[0], SMOOTHING_RANGE[1], global.responsiveness),
    predictionSec: lerp(PREDICTION_RANGE[0], PREDICTION_RANGE[1], global.responsiveness),
  })
  const ready = camera.status === 'ready' && tracking.status === 'ready'
  const phase: Phase = requestedPhase === 'starting' && ready ? 'playing' : requestedPhase
  const active = phase === 'playing' && !settingsOpen

  useEffect(() => {
    if (phase === 'playing' && !announcedRef.current) {
      announcedRef.current = true
      say(`${mode.tip} ${game.howTo}`)
    }
    if (phase === 'intro') announcedRef.current = false
  }, [phase, game.howTo, mode.tip])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      setRequestedPhase('break')
      playCheer()
      say('Great playing! Time for a little break. Bye bye!')
    }, global.sessionMinutes * 60_000)
    return () => clearTimeout(timer)
  }, [active, global.sessionMinutes])

  useEffect(() => {
    if (!active) return
    let lastSeen = performance.now()
    const poll = setInterval(() => {
      if (tracking.pointersRef.current.length > 0) lastSeen = performance.now()
      setShowHint(performance.now() - lastSeen > NO_POINTER_HINT_MS)
    }, HINT_POLL_MS)
    return () => {
      clearInterval(poll)
      setShowHint(false)
    }
  }, [active, tracking.pointersRef])

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

  const stage: GameStage = { canvasRef, pointersRef: tracking.pointersRef, poseRef: tracking.poseRef, size, active }
  const hintText = mode.model === 'pose' ? '🧍 Step back so I can see you!' : '👋 Show me your hand!'

  return (
    <div className="shell" style={{ '--accent': game.accent } as CSSProperties}>
      <div ref={stageRef} className="shell__stage">
        <video ref={videoRef} className="shell__video" style={{ opacity: global.cameraVisibility }} playsInline muted autoPlay />
        <canvas ref={canvasRef} className="shell__canvas" aria-label={`${game.title} play area`} />
        {children(stage)}
        {showHint && active && <div className="shell__hint">{hintText}</div>}
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

      {global.showFps && devicesEnabled && (
        <div className="shell__fps" aria-live="off">
          {tracking.fps} fps · {mode.emoji} {mode.label} · {global.cameraQuality} camera
        </div>
      )}

      {phase === 'intro' && (
        <IntroOverlay
          game={game}
          mode={mode.id}
          onModeChange={(interaction) => updateGlobal({ interaction })}
          onStart={start}
          onExit={exit}
        />
      )}
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
      {settingsOpen && <SettingsPanel gameId={game.id} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
