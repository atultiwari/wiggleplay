import { describe, expect, it } from 'vitest'
import { ASK_SEC, callProgress, CALLS_PER_ANIMAL, createCallState, currentAnimal, DANCE_SEC, HOLD_SEC, NUDGE_SEC, stepCall, type CallInput, type CallState } from './logic'

const quiet: CallInput = { level: 0 }
const loud: CallInput = { level: 0.9 }
const run = (state: CallState, seconds: number, input: CallInput, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepCall(current, dt, input).state
  return current
}

describe('animal call', () => {
  it('asks on the first frame and then listens', () => {
    const first = stepCall(createCallState(), 0.05, quiet)
    expect(first.events.asked).toBe('cow')
    const listening = run(first.state, ASK_SEC, quiet)
    expect(listening.phase).toBe('listening')
  })

  it('dances once the child is loud enough for long enough, then moves on after two calls', () => {
    const listening = run(createCallState(), ASK_SEC + 0.1, quiet)
    let state = listening
    let answered = null
    for (let t = 0; t < HOLD_SEC + 0.1 && !answered; t += 0.05) {
      const step = stepCall(state, 0.05, loud)
      state = step.state
      answered = step.events.answered
    }
    expect(answered).toBe('cow')
    expect(callProgress(state)).toBe(0)
    expect(state.phase).toBe('dancing')
    state = run(state, DANCE_SEC + 0.1, quiet)
    expect(state.phase).toBe('listening')
    state = run(state, HOLD_SEC + 0.2, loud)
    expect(state.answered).toBe(CALLS_PER_ANIMAL)
    const moved = run(state, DANCE_SEC + 0.1, quiet)
    expect(currentAnimal(moved)).toBe('sheep')
    expect(moved.phase).toBe('asking')
  })

  it('ignores short blips and respects the loudness setting', () => {
    const listening = run(createCallState(), ASK_SEC + 0.1, quiet)
    const blip = stepCall(listening, 0.05, loud).state
    const after = run(blip, 0.3, quiet)
    expect(after.phase).toBe('listening')
    expect(callProgress(after)).toBe(0)
    const tooQuiet = run(listening, 2, { level: 0.3, config: { loudness: 0.5 } })
    expect(tooQuiet.phase).toBe('listening')
    const okay = run(listening, 1, { level: 0.3, config: { loudness: 0.2 } })
    expect(okay.phase).toBe('dancing')
  })

  it('nudges the child after a long silence', () => {
    const listening = run(createCallState(), ASK_SEC + 0.1, quiet)
    let nudged = false
    let state = listening
    for (let t = 0; t < NUDGE_SEC + 0.2; t += 0.05) {
      const step = stepCall(state, 0.05, quiet)
      state = step.state
      nudged = nudged || step.events.nudge
    }
    expect(nudged).toBe(true)
    expect(state.phase).toBe('listening')
  })
})
