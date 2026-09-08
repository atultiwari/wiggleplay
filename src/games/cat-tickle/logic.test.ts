import { createSeededRng } from '../../lib/game/random'
import { makeHand } from '../../test/hands'
import {
  APPEAR_SEC,
  CAT_KINDS,
  catScale,
  configFromSettings,
  createCatState,
  DEFAULT_CAT_CONFIG,
  HAPPY_SEC,
  MILESTONE_EVERY,
  spawnCat,
  stepCats,
  type Cat,
  type CatState,
} from './logic'

const size = { width: 1000, height: 700 }
const waitingCat = (x: number, y: number, id = 1): Cat => ({ id, kind: 'orange', x, y, size: 170, phase: 'waiting', phaseSec: 0 })

describe('tickle the cat', () => {
  it('spawns cats inside the play area, away from others', () => {
    const rng = createSeededRng(1)
    const first = spawnCat(size.width, size.height, [], 1, rng)
    expect(CAT_KINDS).toContain(first.kind)
    expect(first.phase).toBe('appearing')
    expect(first.x).toBeGreaterThanOrEqual(first.size / 2)
    expect(first.y).toBeGreaterThan(100)
    const second = spawnCat(size.width, size.height, [first], 2, rng)
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(150)
  })

  it('pops in, waits, then leaves on its own', () => {
    let state: CatState = { ...createCatState(), cats: [{ ...waitingCat(500, 400), phase: 'appearing' as const }], spawnInSec: 99 }
    state = stepCats(state, APPEAR_SEC + 0.01, { pointers: [], ...size }).state
    expect(state.cats[0].phase).toBe('waiting')
    state = stepCats(state, DEFAULT_CAT_CONFIG.stayForSec + 0.01, { pointers: [], ...size }).state
    expect(state.cats[0].phase).toBe('leaving')
    state = stepCats(state, 1, { pointers: [], ...size }).state
    expect(state.cats).toHaveLength(0)
  })

  it('gets happy when touched and then disappears', () => {
    const state = { ...createCatState(), cats: [waitingCat(500, 400)], spawnInSec: 99 }
    const { state: next, events } = stepCats(state, 0.016, { pointers: [makeHand(1, { x: 560, y: 400 })], ...size })
    expect(events.tickled).toHaveLength(1)
    expect(next.cats[0].phase).toBe('happy')
    expect(next.tickled).toBe(1)
    expect(next.particles.length).toBeGreaterThan(0)
    const again = stepCats(next, 0.1, { pointers: [makeHand(1, { x: 560, y: 400 })], ...size })
    expect(again.events.tickled).toHaveLength(0)
    const gone = stepCats(again.state, HAPPY_SEC, { pointers: [], ...size }).state
    expect(gone.cats).toHaveLength(0)
  })

  it('animates scale by phase', () => {
    expect(catScale({ ...waitingCat(0, 0), phase: 'appearing', phaseSec: 0 })).toBe(0)
    expect(catScale({ ...waitingCat(0, 0), phase: 'appearing', phaseSec: APPEAR_SEC })).toBe(1)
    expect(catScale(waitingCat(0, 0))).toBeCloseTo(1, 1)
    expect(catScale({ ...waitingCat(0, 0), phase: 'leaving', phaseSec: 1 })).toBe(0)
  })

  it('respects the cat cap and flags milestones', () => {
    let state = createCatState()
    const config = { ...DEFAULT_CAT_CONFIG, maxCats: 2, stayForSec: 99 }
    for (let i = 0; i < 60; i += 1) state = stepCats(state, 0.1, { pointers: [], ...size, config }, createSeededRng(i)).state
    expect(state.cats.length).toBeLessThanOrEqual(2)
    const near = { ...createCatState(), cats: [waitingCat(500, 400)], tickled: MILESTONE_EVERY - 1, spawnInSec: 99 }
    expect(stepCats(near, 0.016, { pointers: [makeHand(1, { x: 500, y: 400 })], ...size }).events.milestone).toBe(true)
  })

  it('maps settings', () => {
    expect(configFromSettings({ maxCats: 5, appearIntervalSec: 2, catSize: 1.5, stayForSec: 6 })).toMatchObject({ maxCats: 5, appearIntervalSec: 2, sizeScale: 1.5, stayForSec: 6 })
  })
})
