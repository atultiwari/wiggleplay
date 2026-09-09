import { describe, expect, it } from 'vitest'
import { createTreeState, DEFAULT_TREE_CONFIG, DROP_COOLDOWN_SEC, GROUND_V, REGROW_SEC, shakeEffort, stepTree, type TreeInput, type TreeState } from './logic'

const still: TreeInput = { shake: 0, dragSpeed: 0 }
const shaking: TreeInput = { shake: 20, dragSpeed: 0 }
const dragging: TreeInput = { shake: 0, dragSpeed: 2000 }
const run = (state: TreeState, seconds: number, input: TreeInput, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepTree(current, dt, input, () => 0.3).state
  return current
}

describe('shake the tree', () => {
  it('hangs the configured number of apples', () => {
    expect(createTreeState({ ...DEFAULT_TREE_CONFIG, appleCount: 7 }).apples).toHaveLength(7)
    expect(createTreeState({ ...DEFAULT_TREE_CONFIG, appleCount: 50 }).apples).toHaveLength(10)
  })

  it('turns a device shake or a finger drag into the same effort, scaled by the setting', () => {
    expect(shakeEffort(still, DEFAULT_TREE_CONFIG)).toBe(0)
    expect(shakeEffort(shaking, DEFAULT_TREE_CONFIG)).toBe(1)
    expect(shakeEffort(dragging, DEFAULT_TREE_CONFIG)).toBe(1)
    expect(shakeEffort({ shake: 6, dragSpeed: 0 }, { appleCount: 5, shakeStrength: 1 })).toBeLessThan(1)
    expect(shakeEffort({ shake: 6, dragSpeed: 0 }, { appleCount: 5, shakeStrength: 0.3 })).toBe(1)
  })

  it('drops one apple per shake burst and counts it when it lands', () => {
    const first = stepTree(createTreeState(), 0.05, shaking, () => 0.3)
    expect(first.events.dropped).not.toBeNull()
    expect(first.state.apples.filter((a) => a.phase === 'falling')).toHaveLength(1)
    const soon = stepTree(first.state, 0.05, shaking, () => 0.3)
    expect(soon.events.dropped).toBeNull()
    const later = run(first.state, DROP_COOLDOWN_SEC + 0.1, shaking)
    expect(later.apples.filter((a) => a.phase !== 'hanging').length).toBeGreaterThanOrEqual(2)
    const landed = run(first.state, 3, still)
    expect(landed.counted).toBe(1)
    expect(landed.apples.find((a) => a.phase === 'landed')?.v).toBe(GROUND_V)
  })

  it('finishes when every apple is down and regrows after a pause', () => {
    let state = createTreeState({ ...DEFAULT_TREE_CONFIG, appleCount: 3 })
    let finished = false
    for (let t = 0; t < 12 && !finished; t += 0.05) {
      const step = stepTree(state, 0.05, shaking, () => 0.3)
      state = step.state
      finished = step.events.finished
    }
    expect(finished).toBe(true)
    expect(state.counted).toBe(3)
    const regrown = run(state, REGROW_SEC + 0.2, still)
    expect(regrown.apples.every((a) => a.phase === 'hanging')).toBe(true)
    expect(regrown.counted).toBe(0)
    expect(regrown.rounds).toBe(1)
  })

  it('wobbles while shaken and settles when still', () => {
    const shaken = stepTree(createTreeState(), 0.05, shaking).state
    expect(shaken.wobble).toBe(1)
    expect(run(shaken, 1, still).wobble).toBe(0)
  })
})
