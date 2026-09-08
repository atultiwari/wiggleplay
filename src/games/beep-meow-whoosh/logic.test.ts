import { createSeededRng } from '../../lib/game/random'
import { makeHand } from '../../test/hands'
import {
  BOUNCE_SEC,
  bounce,
  configFromSettings,
  createBeepState,
  DEFAULT_BEEP_CONFIG,
  POKE_COOLDOWN_SEC,
  PROMPT_SEC,
  spawnThing,
  stepBeep,
  THING_INFO,
  THING_KINDS,
  type BeepState,
  type Thing,
} from './logic'

const size = { width: 1200, height: 700 }
const thingAt = (kind: Thing['kind'], x: number, id = 1): Thing => ({
  ...spawnThing(size.width, size.height, id, createSeededRng(1), DEFAULT_BEEP_CONFIG, kind),
  x,
  vx: 0,
})

describe('beep meow whoosh', () => {
  it('spawns things in their lane, entering from the correct side', () => {
    const plane = spawnThing(size.width, size.height, 1, createSeededRng(2), DEFAULT_BEEP_CONFIG, 'plane')
    expect(plane.x).toBeLessThan(0)
    expect(plane.vx).toBeGreaterThan(0)
    expect(plane.y).toBeCloseTo(size.height * THING_INFO.plane.laneY, -2)
    const cat = spawnThing(size.width, size.height, 2, createSeededRng(3), DEFAULT_BEEP_CONFIG, 'cat')
    expect(cat.x).toBeGreaterThan(size.width)
    expect(cat.vx).toBeLessThan(0)
    expect(THING_INFO.cat.arts).toContain(cat.art)
    expect(THING_KINDS).toHaveLength(3)
  })

  it('pokes a touched thing once per cooldown', () => {
    const state = { ...createBeepState(), things: [thingAt('bus', 600)], spawnInSec: 99, promptInSec: 99 }
    const hand = makeHand(1, { x: 600, y: state.things[0].y })
    const first = stepBeep(state, 0.016, { pointers: [hand], ...size })
    expect(first.events.poked).toHaveLength(1)
    expect(first.state.poked).toBe(1)
    const second = stepBeep(first.state, 0.016, { pointers: [hand], ...size })
    expect(second.events.poked).toHaveLength(0)
    const later = stepBeep(second.state, POKE_COOLDOWN_SEC, { pointers: [hand], ...size })
    expect(later.events.poked).toHaveLength(1)
  })

  it('asks for a kind on screen and celebrates when it is found', () => {
    let state: BeepState = { ...createBeepState(), things: [thingAt('cat', 600)], spawnInSec: 99, promptInSec: 0 }
    const asked = stepBeep(state, 0.016, { pointers: [], ...size }, createSeededRng(4))
    expect(asked.events.asked).toBe('cat')
    expect(asked.state.prompt?.kind).toBe('cat')
    state = asked.state
    const found = stepBeep(state, 0.016, { pointers: [makeHand(1, { x: 600, y: state.things[0].y })], ...size })
    expect(found.events.found).toBe('cat')
    expect(found.state.prompt).toBeNull()
    expect(found.state.found).toBe(1)
  })

  it('lets a prompt expire quietly and can be switched off', () => {
    const state = { ...createBeepState(), things: [thingAt('plane', 600)], prompt: { kind: 'plane' as const, remainingSec: 0.01 }, spawnInSec: 99 }
    const expired = stepBeep(state, 0.05, { pointers: [], ...size })
    expect(expired.state.prompt).toBeNull()
    expect(expired.events.found).toBeNull()
    const off = { ...createBeepState(), things: [thingAt('plane', 600)], spawnInSec: 99, promptInSec: 0 }
    expect(stepBeep(off, 0.016, { pointers: [], ...size, config: { ...DEFAULT_BEEP_CONFIG, askQuestions: false } }).events.asked).toBeNull()
    expect(PROMPT_SEC).toBeGreaterThan(0)
  })

  it('removes things that left the screen and respects the cap', () => {
    let state: BeepState = { ...createBeepState(), things: [{ ...thingAt('bus', 600), x: size.width + 2000 }], spawnInSec: 99 }
    state = stepBeep(state, 0.016, { pointers: [], ...size }).state
    expect(state.things).toHaveLength(0)
    const config = { ...DEFAULT_BEEP_CONFIG, maxThings: 2 }
    for (let i = 0; i < 100; i += 1) state = stepBeep(state, 0.1, { pointers: [], ...size, config }, createSeededRng(i)).state
    expect(state.things.length).toBeLessThanOrEqual(2)
  })

  it('bounces after a poke and maps settings', () => {
    expect(bounce({ ...thingAt('cat', 0), pokedSec: BOUNCE_SEC / 2 }).lift).toBeGreaterThan(0)
    expect(bounce({ ...thingAt('cat', 0), pokedSec: 5 })).toEqual({ lift: 0, scale: 1 })
    expect(configFromSettings({ maxThings: 8, speed: 2, thingSize: 0.5, askQuestions: false })).toMatchObject({ maxThings: 8, speedScale: 2, sizeScale: 0.5, askQuestions: false })
  })
})
