import { ART } from '../../assets/art'
import type { GameMeta } from '../../config/games'
import type { CameraState } from '../../lib/camera/useCamera'
import { INTERACTION_MODES, modeInfo, type InteractionMode } from '../../lib/tracking/modes'
import type { TrackerStatus } from '../../lib/tracking/useTracking'
import { HoldButton } from './HoldButton'
import './Overlays.css'

interface IntroOverlayProps {
  readonly game: GameMeta
  readonly mode: InteractionMode
  readonly onModeChange: (mode: InteractionMode) => void
  readonly onStart: () => void
  readonly onExit: () => void
}

export const IntroOverlay = ({ game, mode, onModeChange, onStart, onExit }: IntroOverlayProps) => (
  <div className="overlay" role="dialog" aria-labelledby="intro-title">
    <img className="overlay__mascot" src={ART.mascot} alt="" width={160} height={160} />
    <h1 id="intro-title" className="overlay__title">
      {game.emoji} {game.title}
    </h1>
    <p className="overlay__text">{game.howTo}</p>
    <button type="button" className="btn btn--big" onClick={onStart} autoFocus>
      ▶ Play
    </button>
    <div className="overlay__modes" role="group" aria-label="How your child plays">
      <span className="overlay__modes-label">Play with:</span>
      {INTERACTION_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`chip ${m.id === mode ? 'chip--on' : ''}`}
          aria-pressed={m.id === mode}
          onClick={() => onModeChange(m.id)}
        >
          {m.emoji} {m.label}
        </button>
      ))}
    </div>
    <p className="overlay__note">
      {modeInfo(mode).description} Grown-ups: the camera stays on this device. Nothing is uploaded.
    </p>
    <HoldButton label="Hold to go home" icon="🏠" onHold={onExit} className="overlay__exit" />
  </div>
)

interface LoadingOverlayProps {
  readonly camera: CameraState
  readonly trackerStatus: TrackerStatus
  readonly trackerError: string | null
  readonly onRetry: () => void
  readonly onExit: () => void
}

const loadingMessage = (camera: CameraState, trackerStatus: TrackerStatus): string => {
  if (camera.status === 'requesting') return 'Asking for the camera…'
  if (trackerStatus === 'loading') return 'Waking up the wiggle magic…'
  return 'Almost there…'
}

export const LoadingOverlay = ({ camera, trackerStatus, trackerError, onRetry, onExit }: LoadingOverlayProps) => {
  const error = camera.error ?? trackerError
  return (
    <div className="overlay" role="status" aria-live="polite">
      <img className={`overlay__mascot ${error ? '' : 'overlay__mascot--bounce'}`} src={ART.mascot} alt="" width={140} height={140} />
      {error ? (
        <>
          <h2 className="overlay__title">Oops!</h2>
          <p className="overlay__text">{error}</p>
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
        <p className="overlay__text overlay__text--big">{loadingMessage(camera, trackerStatus)}</p>
      )}
      <HoldButton label="Hold to go home" icon="🏠" onHold={onExit} className="overlay__exit" />
    </div>
  )
}

interface BreakOverlayProps {
  readonly onMore: () => void
  readonly onExit: () => void
}

export const BreakOverlay = ({ onMore, onExit }: BreakOverlayProps) => (
  <div className="overlay" role="dialog" aria-labelledby="break-title">
    <img className="overlay__mascot overlay__mascot--wave" src={ART.mascot} alt="" width={160} height={160} />
    <h2 id="break-title" className="overlay__title">
      Bye bye! 👋
    </h2>
    <p className="overlay__text">Great wiggling! Time for a little break.</p>
    <div className="overlay__actions">
      <HoldButton label="Hold for 5 more minutes" icon="⏰" onHold={onMore} />
      <HoldButton label="Hold to go home" icon="🏠" onHold={onExit} />
    </div>
    <p className="overlay__note">Grown-ups: press and hold a button to choose.</p>
  </div>
)
