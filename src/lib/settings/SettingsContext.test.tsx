import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DEFAULT_SETTINGS } from './schema'
import { useSettings, useSettingsRef } from './context'
import { SettingsProvider } from './SettingsContext'
import { getEffectsVolume } from '../audio/sfx'
import { getVoiceConfig } from '../audio/voice'

const wrapper = ({ children }: { children: ReactNode }) => <SettingsProvider persist={false}>{children}</SettingsProvider>

describe('SettingsProvider', () => {
  it('updates global and game slices immutably and resets them', () => {
    const { result } = renderHook(() => useSettings(), { wrapper })
    const before = result.current.settings
    act(() => result.current.updateGlobal({ effectsVolume: 3 }))
    act(() => result.current.updateGame('fruitSlice', { maxFruits: 8 }))
    expect(result.current.settings.global.effectsVolume).toBe(3)
    expect(result.current.settings.fruitSlice.maxFruits).toBe(8)
    expect(before.global.effectsVolume).toBe(DEFAULT_SETTINGS.global.effectsVolume)
    act(() => result.current.resetGame('fruitSlice'))
    expect(result.current.settings.fruitSlice).toEqual(DEFAULT_SETTINGS.fruitSlice)
    act(() => result.current.resetAll())
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('pushes volume and voice settings into the audio modules', () => {
    const { result } = renderHook(() => useSettings(), { wrapper })
    act(() => result.current.updateGlobal({ effectsVolume: 2.5, voiceEnabled: false, voiceVolume: 0.3 }))
    expect(getEffectsVolume()).toBe(2.5)
    expect(getVoiceConfig()).toEqual({ enabled: false, volume: 0.3 })
  })

  it('exposes a ref that tracks the latest settings', () => {
    const { result } = renderHook(() => ({ ref: useSettingsRef(), api: useSettings() }), { wrapper })
    act(() => result.current.api.updateGame('wavePop', { maxBubbles: 3 }))
    expect(result.current.ref.current.wavePop.maxBubbles).toBe(3)
  })

  it('throws outside the provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useSettings())).toThrow('SettingsProvider')
    error.mockRestore()
  })
})
