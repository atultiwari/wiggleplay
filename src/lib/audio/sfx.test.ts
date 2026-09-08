import { getEffectsVolume, MAX_EFFECTS_VOLUME, playPop, setEffectsVolume, unlockAudio } from './sfx'

describe('sfx', () => {
  it('clamps the requested volume', () => {
    setEffectsVolume(10)
    expect(getEffectsVolume()).toBe(MAX_EFFECTS_VOLUME)
    setEffectsVolume(-2)
    expect(getEffectsVolume()).toBe(0)
    setEffectsVolume(1.5)
    expect(getEffectsVolume()).toBe(1.5)
  })

  it('stays silent and safe without an AudioContext', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await unlockAudio()).toBe(false)
    expect(() => playPop()).not.toThrow()
    warn.mockRestore()
  })
})
