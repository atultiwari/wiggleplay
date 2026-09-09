import { describe, expect, it } from 'vitest'
import { animalAt, animalCentre, animalSize, createFarmState, DEFAULT_FARM_CONFIG, FIRST_PROMPT_SEC, HAPPY_SEC, PROMPT_TIMEOUT_SEC, stepFarm, type FarmInput, type FarmState } from './logic'

const W = 1000
const H = 600
const idle: FarmInput = { taps: [], width: W, height: H }
const run = (state: FarmState, seconds: number, input: FarmInput, rng = () => 0.1, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepFarm(current, dt, input, rng).state
  return current
}

describe('tap the farm', () => {
  it('places as many animals as configured without overlaps', () => {
    const state = createFarmState({ ...DEFAULT_FARM_CONFIG, animalCount: 6 })
    expect(state.animals).toHaveLength(6)
    const size = animalSize(W, H, DEFAULT_FARM_CONFIG)
    state.animals.forEach((a, i) =>
      state.animals.slice(i + 1).forEach((b) => {
        const d = Math.hypot(a.u * W - b.u * W, a.v * H - b.v * H)
        expect(d).toBeGreaterThan(size * 0.9)
      }),
    )
    expect(createFarmState({ ...DEFAULT_FARM_CONFIG, animalCount: 99 }).animals).toHaveLength(6)
  })

  it('finds the animal under a generous tap and makes it happy', () => {
    const state = createFarmState()
    const cow = state.animals[0]
    const centre = animalCentre(cow, W, H)
    const near = { x: centre.x + animalSize(W, H, DEFAULT_FARM_CONFIG) * 0.5, y: centre.y }
    expect(animalAt(state.animals, near, W, H, DEFAULT_FARM_CONFIG)?.kind).toBe('cow')
    expect(animalAt(state.animals, { x: 5, y: 5 }, W, H, DEFAULT_FARM_CONFIG)).toBeUndefined()
    const { state: next, events } = stepFarm(state, 0.05, { ...idle, taps: [near] })
    expect(events.tapped).toEqual(['cow'])
    expect(next.animals[0].happySec).toBe(HAPPY_SEC)
    expect(next.animals[0].taps).toBe(1)
    expect(run(next, HAPPY_SEC + 0.1, idle).animals[0].happySec).toBe(0)
  })

  it('asks for an animal, celebrates the right tap and ignores the wrong one', () => {
    const asked = stepFarm(run(createFarmState(), FIRST_PROMPT_SEC - 0.02, idle), 0.1, idle, () => 0.5)
    expect(asked.events.promptAsked).not.toBeNull()
    const target = asked.state.prompt!
    const other = asked.state.animals.find((a) => a.kind !== target)!
    const wrong = stepFarm(asked.state, 0.05, { ...idle, taps: [animalCentre(other, W, H)] })
    expect(wrong.events.promptSolved).toBeNull()
    const targetAnimal = asked.state.animals.find((a) => a.kind === target)!
    const right = stepFarm(wrong.state, 0.05, { ...idle, taps: [animalCentre(targetAnimal, W, H)] })
    expect(right.events.promptSolved).toBe(target)
    expect(right.state.found).toBe(1)
    expect(right.state.prompt).toBeNull()
  })

  it('gives up on a prompt after the timeout and stays quiet when questions are off', () => {
    const asked = stepFarm(run(createFarmState(), FIRST_PROMPT_SEC - 0.02, idle), 0.1, idle)
    const missed = run(asked.state, PROMPT_TIMEOUT_SEC + 0.2, idle)
    expect(missed.prompt).toBeNull()
    const quiet = run(createFarmState(), 30, { ...idle, config: { ...DEFAULT_FARM_CONFIG, askQuestions: false } })
    expect(quiet.prompt).toBeNull()
  })
})
