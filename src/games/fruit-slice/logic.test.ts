import { createSeededRng } from '../../lib/game/random'
import { makeHand } from '../../test/hands'
import {
  bladeSegments,
  createSliceState,
  FRUIT_KINDS,
  launchFruit,
  MILESTONE_EVERY,
  SLICE_MIN_SPEED,
  stepSlice,
  TRAIL_LENGTH,
  updateTrails,
  type SliceState,
} from './logic'

const size = { width: 1000, height: 600 }
const fruitAt = (x: number, y: number) => ({
  ...launchFruit(size.width, size.height, 1, createSeededRng(1)),
  x,
  y,
  vx: 0,
  vy: 0,
})

describe('fruit slice logic', () => {
  it('launches fruit upward from below the screen', () => {
    const fruit = launchFruit(size.width, size.height, 3, createSeededRng(2))
    expect(fruit.id).toBe(3)
    expect(fruit.y).toBeGreaterThan(size.height)
    expect(fruit.vy).toBeLessThan(0)
    expect(FRUIT_KINDS).toContain(fruit.kind)
  })

  it('builds blade segments only for hands with a previous trail point', () => {
    const hand = makeHand(1, { x: 100, y: 100 })
    expect(bladeSegments([], [hand], 0.016)).toHaveLength(0)
    const trails = updateTrails([], [hand])
    const moved = makeHand(1, { x: 200, y: 100 })
    const [segment] = bladeSegments(trails, [moved], 0.1)
    expect(segment.a).toEqual({ x: 100, y: 100 })
    expect(segment.b).toEqual({ x: 200, y: 100 })
    expect(segment.speed).toBeCloseTo(1000)
  })

  it('keeps trails short', () => {
    let trails = updateTrails([], [])
    for (let i = 0; i < TRAIL_LENGTH * 2; i += 1) trails = updateTrails(trails, [makeHand(1, { x: i, y: 0 })])
    expect(trails[0].points).toHaveLength(TRAIL_LENGTH)
  })

  it('slices a fruit crossed by a fast blade and spawns halves plus juice', () => {
    const fruit = fruitAt(500, 300)
    const start = makeHand(1, { x: 400, y: 300 })
    let state: SliceState = { ...createSliceState(), fruits: [fruit], spawnInSec: 99 }
    state = stepSlice(state, 0.016, { hands: [start], ...size }, createSeededRng(3)).state
    const swipe = makeHand(1, { x: 600, y: 300 })
    const { state: next, events } = stepSlice(state, 0.016, { hands: [swipe], ...size }, createSeededRng(4))
    expect(events.sliced).toHaveLength(1)
    expect(next.fruits).toHaveLength(0)
    expect(next.halves).toHaveLength(2)
    expect(next.halves.map((h) => h.side).sort()).toEqual(['left', 'right'])
    expect(next.particles.length).toBeGreaterThan(0)
    expect(next.sliced).toBe(1)
  })

  it('ignores a slow hover over a fruit', () => {
    const fruit = fruitAt(500, 300)
    const start = makeHand(1, { x: 495, y: 300 })
    let state: SliceState = { ...createSliceState(), fruits: [fruit], spawnInSec: 99 }
    state = stepSlice(state, 0.016, { hands: [start], ...size }).state
    const slow = makeHand(1, { x: 496, y: 300 })
    const dt = 1
    expect(1 / dt).toBeLessThan(SLICE_MIN_SPEED)
    const { events } = stepSlice(state, dt, { hands: [slow], ...size })
    expect(events.sliced).toHaveLength(0)
  })

  it('removes fruit that fell off the bottom and spawns new ones', () => {
    const fallen = { ...fruitAt(500, size.height + 500), id: 99 }
    const state = { ...createSliceState(), fruits: [fallen], spawnInSec: 0 }
    const { state: next } = stepSlice(state, 0.016, { hands: [], ...size }, createSeededRng(5))
    expect(next.fruits.every((f) => f.id !== fallen.id)).toBe(true)
    expect(next.fruits).toHaveLength(1)
  })

  it('expires halves and flags milestones', () => {
    const fruit = fruitAt(500, 300)
    let state: SliceState = { ...createSliceState(), fruits: [fruit], sliced: MILESTONE_EVERY - 1, spawnInSec: 99 }
    state = stepSlice(state, 0.016, { hands: [makeHand(1, { x: 400, y: 300 })], ...size }).state
    const { state: sliced, events } = stepSlice(state, 0.016, { hands: [makeHand(1, { x: 600, y: 300 })], ...size })
    expect(events.milestone).toBe(true)
    const later = stepSlice(sliced, 5, { hands: [], ...size }).state
    expect(later.halves).toHaveLength(0)
  })
})
