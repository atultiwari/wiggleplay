import { createSeededRng } from '../../lib/game/random'
import { makeHand } from '../../test/hands'
import { bubbleDrawX, configFromSettings, createPopState, DEFAULT_POP_CONFIG, MILESTONE_EVERY, spawnBubble, stepPop } from './logic'

const size = { width: 800, height: 600 }

describe('wave pop logic', () => {
  it('spawns bubbles below the screen and caps their number', () => {
    const bubble = spawnBubble(size.width, size.height, 1, createSeededRng(1))
    expect(bubble.y).toBeGreaterThan(size.height)
    let state = createPopState()
    const rng = createSeededRng(2)
    for (let i = 0; i < 200; i += 1) state = stepPop(state, 0.1, { hands: [], ...size }, rng).state
    expect(state.bubbles.length).toBeLessThanOrEqual(DEFAULT_POP_CONFIG.maxBubbles)
    expect(state.bubbles.length).toBeGreaterThan(0)
  })

  it('pops a bubble touched by any hand landmark', () => {
    const bubble = { ...spawnBubble(size.width, size.height, 1, createSeededRng(3)), x: 400, y: 300, wobbleAmp: 0 }
    const state = { ...createPopState(), bubbles: [bubble], spawnInSec: 99 }
    const hand = makeHand(1, { x: 400 + bubble.r, y: 300 })
    const { state: next, events } = stepPop(state, 0.016, { hands: [hand], ...size }, createSeededRng(4))
    expect(events.popped).toHaveLength(1)
    expect(next.bubbles).toHaveLength(0)
    expect(next.popped).toBe(1)
    expect(next.particles.length).toBeGreaterThan(0)
  })

  it('does not pop bubbles far from the hand', () => {
    const bubble = { ...spawnBubble(size.width, size.height, 1, createSeededRng(5)), x: 100, y: 100, wobbleAmp: 0 }
    const state = { ...createPopState(), bubbles: [bubble], spawnInSec: 99 }
    const { events } = stepPop(state, 0.016, { hands: [makeHand(1, { x: 700, y: 500 })], ...size }, createSeededRng(6))
    expect(events.popped).toHaveLength(0)
  })

  it('removes bubbles that float off the top', () => {
    const bubble = { ...spawnBubble(size.width, size.height, 1, createSeededRng(7)), y: -500 }
    const state = { ...createPopState(), bubbles: [bubble], spawnInSec: 99 }
    expect(stepPop(state, 0.016, { hands: [], ...size }).state.bubbles).toHaveLength(0)
  })

  it('flags a milestone every ten pops', () => {
    const bubble = { ...spawnBubble(size.width, size.height, 1, createSeededRng(8)), x: 400, y: 300, wobbleAmp: 0 }
    const state = { ...createPopState(), bubbles: [bubble], popped: MILESTONE_EVERY - 1, spawnInSec: 99 }
    const { events } = stepPop(state, 0.016, { hands: [makeHand(1, { x: 400, y: 300 })], ...size }, createSeededRng(9))
    expect(events.milestone).toBe(true)
  })

  it('wobbles around the base x', () => {
    const bubble = { ...spawnBubble(size.width, size.height, 1, createSeededRng(10)), x: 100, wobbleAmp: 10, wobblePhase: 0 }
    expect(Math.abs(bubbleDrawX(bubble, 0) - 100)).toBeLessThanOrEqual(10)
  })
})

describe('wave pop config', () => {
  it('maps parent settings to the rules', () => {
    const config = configFromSettings({ maxBubbles: 12, spawnIntervalSec: 0.5, bubbleSize: 1.5, riseSpeed: 2 })
    expect(config).toEqual({ maxBubbles: 12, spawnIntervalSec: 0.5, sizeScale: 1.5, speedScale: 2, hitMarginPx: DEFAULT_POP_CONFIG.hitMarginPx })
  })

  it('applies size, speed and the bubble cap', () => {
    const config = { ...DEFAULT_POP_CONFIG, sizeScale: 2, speedScale: 3, maxBubbles: 2 }
    const big = spawnBubble(size.width, size.height, 1, createSeededRng(11), config)
    const normal = spawnBubble(size.width, size.height, 1, createSeededRng(11))
    expect(big.r).toBeCloseTo(normal.r * 2)
    expect(big.vy).toBeCloseTo(normal.vy * 3)
    let state = createPopState()
    for (let i = 0; i < 100; i += 1) state = stepPop(state, 0.1, { hands: [], ...size, config }, createSeededRng(i)).state
    expect(state.bubbles.length).toBeLessThanOrEqual(2)
  })
})
