import { DEFAULT_SETTINGS, GAME_SETTINGS_KEYS, GLOBAL_RANGES, sanitizeSettings } from './schema'
import { GAMES } from '../../config/games'

describe('sanitizeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ global: 5, wavePop: null })).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numbers into range, rounds counts and validates choices', () => {
    const result = sanitizeSettings({
      global: { effectsVolume: 99, voiceVolume: -1, cameraQuality: 'ultra', handsTracked: 3, sessionMinutes: 1, showFps: 'yes' },
      wavePop: { maxBubbles: 4.6, spawnIntervalSec: 0 },
      fruitSlice: { tolerance: 'generous', maxFruits: 100 },
    })
    expect(result.global.effectsVolume).toBe(GLOBAL_RANGES.effectsVolume.max)
    expect(result.global.voiceVolume).toBe(0)
    expect(result.global.cameraQuality).toBe('medium')
    expect(result.global.handsTracked).toBe('auto')
    expect(result.global.sessionMinutes).toBe(GLOBAL_RANGES.sessionMinutes.min)
    expect(result.global.showFps).toBe(false)
    expect(result.wavePop.maxBubbles).toBe(5)
    expect(result.wavePop.spawnIntervalSec).toBe(0.2)
    expect(result.fruitSlice.tolerance).toBe('generous')
    expect(result.fruitSlice.maxFruits).toBe(10)
  })

  it('upgrades the old -1 camera visibility to the 50% default and drops unknown fields', () => {
    const result = sanitizeSettings({ global: { cameraVisibility: -1, hacker: true }, extra: {} })
    expect(result.global.cameraVisibility).toBe(0.5)
    expect('hacker' in result.global).toBe(false)
    expect('extra' in result).toBe(false)
    expect(sanitizeSettings({ global: { cameraVisibility: 0.3 } }).global.cameraVisibility).toBe(0.3)
    expect(DEFAULT_SETTINGS.global.cameraVisibility).toBe(0.5)
  })

  it('validates the interaction mode and the new game slices', () => {
    expect(sanitizeSettings({ global: { interaction: 'tail' } }).global.interaction).toBe('body')
    expect(sanitizeSettings({ global: { interaction: 'finger' } }).global.interaction).toBe('finger')
    const result = sanitizeSettings({ catTickle: { maxCats: 99 }, beepMeow: { askQuestions: 'no' }, busDriver: { busSize: 0.1 } })
    expect(result.catTickle.maxCats).toBe(8)
    expect(result.beepMeow.askQuestions).toBe(true)
    expect(result.busDriver.busSize).toBe(0.6)
    expect(result.flyHigh).toEqual(DEFAULT_SETTINGS.flyHigh)
  })

  it('has a settings slice for every ready game', () => {
    GAMES.filter((g) => g.status === 'ready').forEach((g) => expect(GAME_SETTINGS_KEYS[g.id]).toBeDefined())
  })
})
