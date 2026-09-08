import { useEffect, useState, type ReactNode } from 'react'
import { setEffectsVolume } from '../audio/sfx'
import { configureVoice } from '../audio/voice'
import { SettingsContext, type SettingsContextValue } from './context'
import { DEFAULT_SETTINGS, type Settings } from './schema'
import { loadSettings, saveSettings } from './storage'

interface SettingsProviderProps {
  readonly children: ReactNode
  /** Mostly for tests: skip localStorage and start from these settings. */
  readonly initialSettings?: Settings
  readonly persist?: boolean
}

export const SettingsProvider = ({ children, initialSettings, persist = true }: SettingsProviderProps) => {
  const [settings, setSettings] = useState<Settings>(() => initialSettings ?? loadSettings())

  useEffect(() => {
    if (persist) saveSettings(settings)
  }, [settings, persist])

  const { effectsVolume, voiceEnabled, voiceVolume } = settings.global
  useEffect(() => {
    setEffectsVolume(effectsVolume)
    configureVoice({ enabled: voiceEnabled, volume: voiceVolume })
  }, [effectsVolume, voiceEnabled, voiceVolume])

  const value: SettingsContextValue = {
    settings,
    updateGlobal: (patch) => setSettings((s) => ({ ...s, global: { ...s.global, ...patch } })),
    updateGame: (key, patch) => setSettings((s) => ({ ...s, [key]: { ...s[key], ...patch } })),
    resetGame: (key) => setSettings((s) => ({ ...s, [key]: DEFAULT_SETTINGS[key] })),
    resetAll: () => setSettings(DEFAULT_SETTINGS),
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
