import { DEFAULT_SETTINGS } from './schema'
import { loadSettings, saveSettings, SETTINGS_KEY } from './storage'
import type { KeyValueStore } from '../storage/progress'

const memoryStore = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...initial }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('settings storage', () => {
  it('round-trips settings', () => {
    const store = memoryStore()
    const custom = { ...DEFAULT_SETTINGS, wavePop: { ...DEFAULT_SETTINGS.wavePop, maxBubbles: 12 } }
    expect(saveSettings(custom, store)).toBe(true)
    expect(loadSettings(store)).toEqual(custom)
  })

  it('falls back to defaults on missing, broken or absent storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(memoryStore({ [SETTINGS_KEY]: '{broken' }))).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(saveSettings(DEFAULT_SETTINGS, null)).toBe(false)
    const broken: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(saveSettings(DEFAULT_SETTINGS, broken)).toBe(false)
    warn.mockRestore()
  })
})
