import { useEffect } from 'react'
import {
  CAMERA_QUALITIES,
  GAME_SETTINGS_KEYS,
  GLOBAL_RANGES,
  HANDS_OPTIONS,
  type CameraQuality,
  type GameSettingsKey,
  type HandsTracked,
} from '../../lib/settings/schema'
import { useSettings } from '../../lib/settings/context'
import { INTERACTION_MODES, modeInfo } from '../../lib/tracking/modes'
import { ChoiceField, SliderField, ToggleField } from './fields'
import { formatMinutes, formatPercent } from './format'
import { GameSettingsSection } from './GameSettingsSection'
import './SettingsPanel.css'

export interface SettingsPanelProps {
  /** When set, only this game's section is shown (titled "This game"). */
  readonly gameId?: string
  readonly onClose: () => void
}

const QUALITY_LABELS: Readonly<Record<CameraQuality, string>> = { low: 'Low (fastest)', medium: 'Medium', high: 'High' }
const HANDS_LABELS: Readonly<Record<string, string>> = { auto: 'Auto', 1: 'One (faster)', 2: 'Two' }

export const SettingsPanel = ({ gameId, onClose }: SettingsPanelProps) => {
  const { settings, updateGlobal, resetAll } = useSettings()
  const g = settings.global
  const currentGameKey = gameId ? GAME_SETTINGS_KEYS[gameId] : undefined
  const gameKeys: readonly GameSettingsKey[] = currentGameKey
    ? [currentGameKey]
    : (Object.values(GAME_SETTINGS_KEYS) as GameSettingsKey[])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings__backdrop" onClick={onClose} aria-hidden="true" data-testid="settings-backdrop" />
      <div className="settings__panel">
        <header className="settings__head">
          <h2 id="settings-title">⚙️ Settings</h2>
          <button type="button" className="settings__close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <div className="settings__body">
          <section className="settings__section" aria-label="How your child plays">
            <div className="settings__section-head">
              <h3>🧒 How your child plays</h3>
            </div>
            <ChoiceField
              label="Interaction"
              value={g.interaction}
              options={INTERACTION_MODES.map((m) => ({ value: m.id, label: `${m.emoji} ${m.label}` }))}
              onChange={(interaction) => updateGlobal({ interaction })}
              hint={modeInfo(g.interaction).description}
            />
            <p className="field__hint">Applies to every game. Whole body is the easiest for toddlers: there is no wrong way to move.</p>
          </section>

          {currentGameKey && <GameSettingsSection settingsKey={currentGameKey} title="🎮 This game" />}

          <section className="settings__section" aria-label="Sound">
            <div className="settings__section-head">
              <h3>🔊 Sound</h3>
            </div>
            <SliderField
              id="g-effects"
              label="Sound effects"
              value={g.effectsVolume}
              range={GLOBAL_RANGES.effectsVolume}
              format={formatPercent}
              onChange={(effectsVolume) => updateGlobal({ effectsVolume })}
              hint="Goes up to 300% for kids who love it loud. A limiter keeps it from distorting."
            />
            <ToggleField id="g-voice" label="Spoken words" checked={g.voiceEnabled} onChange={(voiceEnabled) => updateGlobal({ voiceEnabled })} />
            <SliderField
              id="g-voice-vol"
              label="Voice volume"
              value={g.voiceVolume}
              range={GLOBAL_RANGES.voiceVolume}
              format={formatPercent}
              disabled={!g.voiceEnabled}
              onChange={(voiceVolume) => updateGlobal({ voiceVolume })}
            />
          </section>

          <section className="settings__section" aria-label="Camera and hand tracking">
            <div className="settings__section-head">
              <h3>📷 Camera & hand tracking</h3>
            </div>
            <SliderField
              id="g-resp"
              label="Responsiveness"
              value={g.responsiveness}
              range={GLOBAL_RANGES.responsiveness}
              format={formatPercent}
              onChange={(responsiveness) => updateGlobal({ responsiveness })}
              hint="Left is smoother but lags a little; right follows the hand instantly but may jitter."
            />
            <ChoiceField
              label="Camera quality"
              value={g.cameraQuality}
              options={CAMERA_QUALITIES.map((value) => ({ value, label: QUALITY_LABELS[value] }))}
              onChange={(cameraQuality) => updateGlobal({ cameraQuality })}
              hint="Lower is faster. Hand tracking works the same at every quality."
            />
            <ChoiceField<HandsTracked>
              label="Hands tracked"
              value={g.handsTracked}
              options={HANDS_OPTIONS.map((value) => ({ value, label: HANDS_LABELS[String(value)] }))}
              onChange={(handsTracked) => updateGlobal({ handsTracked })}
              hint="Hand modes only. Auto uses what each game needs; one hand is fastest on slow laptops."
            />
            <ToggleField id="g-cursor" label="Show cursor on the tracked part" checked={g.showHandCursor} onChange={(showHandCursor) => updateGlobal({ showHandCursor })} />
            <SliderField
              id="g-cam-vis"
              label="How visible you are behind the game"
              value={g.cameraVisibility}
              range={GLOBAL_RANGES.cameraVisibility}
              format={formatPercent}
              onChange={(cameraVisibility) => updateGlobal({ cameraVisibility })}
              hint="0% hides the camera picture, 100% shows it fully. Default 50%."
            />
            <ToggleField id="g-fps" label="Show tracking speed (FPS)" checked={g.showFps} onChange={(showFps) => updateGlobal({ showFps })} />
          </section>

          <section className="settings__section" aria-label="Session">
            <div className="settings__section-head">
              <h3>⏰ Session</h3>
            </div>
            <SliderField
              id="g-session"
              label="Play time before the bye-bye screen"
              value={g.sessionMinutes}
              range={GLOBAL_RANGES.sessionMinutes}
              format={formatMinutes}
              onChange={(sessionMinutes) => updateGlobal({ sessionMinutes })}
            />
          </section>

          {!currentGameKey && gameKeys.map((key) => <GameSettingsSection key={key} settingsKey={key} />)}

          <button type="button" className="btn btn--ghost settings__reset-all" onClick={resetAll}>
            Reset everything to defaults
          </button>
        </div>
      </div>
    </div>
  )
}
