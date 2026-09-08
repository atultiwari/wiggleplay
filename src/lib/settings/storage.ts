import type { KeyValueStore } from '../storage/progress'
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './schema'

export const SETTINGS_KEY = 'wiggleplay.settings.v1'

const safeStore = (): KeyValueStore | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export const loadSettings = (store: KeyValueStore | null = safeStore()): Settings => {
  if (!store) return DEFAULT_SETTINGS
  try {
    const raw = store.getItem(SETTINGS_KEY)
    return raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS
  } catch (error) {
    console.warn('[settings] could not read saved settings, using defaults', error)
    return DEFAULT_SETTINGS
  }
}

export const saveSettings = (settings: Settings, store: KeyValueStore | null = safeStore()): boolean => {
  if (!store) return false
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch (error) {
    console.warn('[settings] could not save settings', error)
    return false
  }
}
