import { createContext, useContext, useEffect, useRef, type RefObject } from 'react'
import type { GameSettingsKey, GlobalSettings, Settings } from './schema'

export interface SettingsContextValue {
  readonly settings: Settings
  readonly updateGlobal: (patch: Partial<GlobalSettings>) => void
  readonly updateGame: <K extends GameSettingsKey>(key: K, patch: Partial<Settings[K]>) => void
  readonly resetGame: (key: GameSettingsKey) => void
  readonly resetAll: () => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export const useSettings = (): SettingsContextValue => {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings must be used inside <SettingsProvider>')
  return context
}

/** Latest settings as a ref, for reading inside a game loop without re-rendering. */
export const useSettingsRef = (): RefObject<Settings> => {
  const { settings } = useSettings()
  const ref = useRef(settings)
  useEffect(() => {
    ref.current = settings
  }, [settings])
  return ref
}
