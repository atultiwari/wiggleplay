import { createSeededRng } from '../../lib/game/random'
import { BASKET, basketCenter, basketTop, COUNT_TARGET, createCatchState, spawnStar, stepCatch } from './logic'

const size = { width: 1000, height: 600 }

describe('catch stars logic', () => {
  it('spawns stars above the screen inside the width', () => {
    const star = spawnStar(size.width, 1, 7, createSeededRng(1))
    expect(star.id).toBe(7)
    expect(star.y).toBeLessThan(0)
    expect(star.x).toBeGreaterThanOrEqual(0)
    expect(star.x).toBeLessThanOrEqual(size.width)
  })

  it('moves the basket toward the hand and spawns over time', () => {
    let state = createCatchState(size.width)
    const rng = createSeededRng(2)
    for (let i = 0; i < 20; i += 1) state = stepCatch(state, 0.1, { targetX: 100, ...size }, rng).state
    expect(state.basketX).toBeLessThan(200)
    expect(state.stars.length).toBeGreaterThan(0)
  })

  it('catches a star that lands in the basket and counts aloud', () => {
    const star = { id: 1, x: 500, y: basketTop(size.height) - 5, vy: 100, rotation: 0, spin: 0, size: 70 }
    const state = { ...createCatchState(size.width), stars: [star], spawnInSec: 99 }
    const { state: next, events } = stepCatch(state, 0.1, { targetX: null, ...size }, createSeededRng(3))
    expect(events.caught).toEqual([1])
    expect(next.count).toBe(1)
    expect(next.total).toBe(1)
    expect(next.stars).toHaveLength(0)
    expect(next.particles.length).toBeGreaterThan(0)
    expect(next.speedScale).toBeGreaterThan(1)
  })

  it('celebrates and resets at ten', () => {
    const star = { id: 1, x: 500, y: basketTop(size.height), vy: 10, rotation: 0, spin: 0, size: 70 }
    const state = { ...createCatchState(size.width), stars: [star], count: COUNT_TARGET - 1, spawnInSec: 99 }
    const { state: next, events } = stepCatch(state, 0.01, { targetX: null, ...size }, createSeededRng(4))
    expect(events.celebrated).toBe(true)
    expect(next.count).toBe(0)
    expect(next.celebrationSec).toBeGreaterThan(0)
  })

  it('lets missed stars fall away and slows down a little', () => {
    const star = { id: 1, x: 50, y: size.height + 200, vy: 100, rotation: 0, spin: 0, size: 70 }
    const state = { ...createCatchState(size.width), stars: [star], spawnInSec: 99 }
    const { state: next, events } = stepCatch(state, 0.1, { targetX: null, ...size }, createSeededRng(5))
    expect(events.missed).toBe(1)
    expect(next.stars).toHaveLength(0)
    expect(next.speedScale).toBeLessThan(1)
  })

  it('drifts the basket back to the middle when no hand is visible', () => {
    const state = { ...createCatchState(size.width), basketX: 0, spawnInSec: 99 }
    const { state: next } = stepCatch(state, 0.1, { targetX: null, ...size }, createSeededRng(6))
    expect(next.basketX).toBeGreaterThan(0)
    expect(next.basketX).toBeLessThan(size.width / 2)
  })

  it('exposes the basket centre', () => {
    const state = createCatchState(size.width)
    expect(basketCenter(state, size.height)).toEqual({ x: 500, y: basketTop(size.height) + BASKET.height / 2 })
  })
})
