import { describe, expect, it } from 'vitest'
import {
  catHeadYaw,
  COOLDOWN_SEC,
  createTownState,
  FIRST_PROMPT_SEC,
  planeBank,
  PROMPT_TIMEOUT_SEC,
  propsUnderPointer,
  ROAD_HALF,
  SKY_HALF,
  stepTown,
  type ScreenSpot,
  type TownInput,
  type TownState,
} from './logic'

const spots: Record<'bus' | 'plane' | 'cat', ScreenSpot> = {
  bus: { x: 400, y: 500, r: 120 },
  plane: { x: 600, y: 150, r: 100 },
  cat: { x: 150, y: 520, r: 110 },
}
const idle: TownInput = { pointer: null, spots }
const run = (state: TownState, seconds: number, input: TownInput, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepTown(current, dt, input).state
  return current
}

describe('toy town movement', () => {
  it('keeps the bus on the road and turns it around at the ends', () => {
    const state = run(createTownState(), 30, idle)
    expect(Math.abs(state.busX)).toBeLessThanOrEqual(ROAD_HALF)
    expect(state.time).toBeGreaterThan(29)
  })

  it('keeps the plane inside the sky and reverses direction', () => {
    const start = createTownState()
    const state = run(start, 9, idle)   // 2.4 -> -3.2 takes 7 s at 0.8 units/s, then it turns
    expect(Math.abs(state.planeX)).toBeLessThanOrEqual(SKY_HALF)
    expect(state.planeDir).not.toBe(start.planeDir)
  })

  it('scales speed with the config', () => {
    const slow = stepTown(createTownState(), 1, { ...idle, config: { propSize: 1, speedScale: 0.5, prompts: false } }).state
    const fast = stepTown(createTownState(), 1, { ...idle, config: { propSize: 1, speedScale: 2, prompts: false } }).state
    expect(fast.busX - createTownState().busX).toBeCloseTo((slow.busX - createTownState().busX) * 4, 5)
  })
})

describe('toy town touching', () => {
  it('finds props under a generous pointer radius', () => {
    expect(propsUnderPointer({ x: 400 + 140, y: 500 }, spots)).toEqual(['bus'])
    expect(propsUnderPointer({ x: 400 + 200, y: 500 }, spots)).toEqual([])
    expect(propsUnderPointer(null, spots)).toEqual([])
  })

  it('counts a touch once and then waits for the cooldown', () => {
    const input: TownInput = { pointer: { x: 150, y: 520 }, spots, config: { propSize: 1, speedScale: 1, prompts: false } }
    const first = stepTown(createTownState(), 0.05, input)
    expect(first.events.touched).toEqual(['cat'])
    expect(first.state.counts.cat).toBe(1)
    expect(first.state.reacting.cat).toBeGreaterThan(0)
    const held = run(first.state, COOLDOWN_SEC - 0.2, input)
    expect(held.counts.cat).toBe(1)
    const again = run(held, 0.5, input)
    expect(again.counts.cat).toBe(2)
  })
})

describe('toy town prompts', () => {
  it('asks for the props in turn and celebrates when the right one is touched', () => {
    const asked = run(createTownState(), FIRST_PROMPT_SEC - 0.02, idle)
    const ask = stepTown(asked, 0.1, idle)
    expect(ask.events.promptAsked).toBe('bus')
    expect(ask.state.prompt).toBe('bus')
    const wrong = stepTown(ask.state, 0.05, { pointer: { x: 150, y: 520 }, spots })
    expect(wrong.events.promptSolved).toBeNull()
    expect(wrong.state.prompt).toBe('bus')
    const right = stepTown(wrong.state, 0.05, { pointer: { x: 400, y: 500 }, spots })
    expect(right.events.promptSolved).toBe('bus')
    expect(right.state.prompt).toBeNull()
  })

  it('gives a hint when the prompt times out and moves on to the next prop', () => {
    const asked = stepTown(run(createTownState(), FIRST_PROMPT_SEC, idle), 0.1, idle)
    const missed = run(asked.state, PROMPT_TIMEOUT_SEC + 0.2, idle)
    expect(missed.prompt).toBeNull()
    const next = stepTown(run(missed, 30, idle), 0.1, idle)
    expect(next.state.promptIndex).toBeGreaterThanOrEqual(2)
  })

  it('never asks when prompts are switched off', () => {
    const state = run(createTownState(), 40, { ...idle, config: { propSize: 1, speedScale: 1, prompts: false } })
    expect(state.prompt).toBeNull()
    expect(state.promptIndex).toBe(0)
  })
})

describe('toy town animation helpers', () => {
  it('turns the cat head toward the pointer within limits', () => {
    expect(catHeadYaw(null, spots.cat)).toBe(0)
    expect(catHeadYaw({ x: 2000, y: 0 }, spots.cat)).toBeCloseTo(0.45)
    expect(catHeadYaw({ x: -2000, y: 0 }, spots.cat)).toBeCloseTo(-0.45)
  })

  it('banks the plane into its direction and wobbles only while reacting', () => {
    expect(planeBank(1, 0, 0)).toBeCloseTo(-0.12)
    expect(planeBank(-1, 0, 3)).toBeCloseTo(0.12)
    expect(Math.abs(planeBank(1, 1, 0.1))).toBeGreaterThan(0.12)
  })
})
