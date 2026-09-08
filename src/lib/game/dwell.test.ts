import { DWELL_IDLE, dwellProgress, updateDwell } from './dwell'

describe('dwell', () => {
  it('stays idle without a target', () => {
    expect(updateDwell(DWELL_IDLE, null, 100, 500)).toEqual({ state: DWELL_IDLE, triggered: null })
  })

  it('accumulates time on the same target and fires once at the threshold', () => {
    let { state } = updateDwell(DWELL_IDLE, 'red', 0, 500)
    expect(dwellProgress(state, 500)).toBe(0)
    ;({ state } = updateDwell(state, 'red', 250, 500))
    expect(dwellProgress(state, 500)).toBe(0.5)
    const fired = updateDwell(state, 'red', 300, 500)
    expect(fired.triggered).toBe('red')
    expect(fired.state.fired).toBe(true)
    const again = updateDwell(fired.state, 'red', 1000, 500)
    expect(again.triggered).toBeNull()
  })

  it('resets when the target changes', () => {
    const { state } = updateDwell(DWELL_IDLE, 'red', 400, 500)
    const switched = updateDwell(state, 'blue', 50, 500)
    expect(switched.state).toEqual({ targetId: 'blue', elapsedMs: 0, fired: false })
    expect(switched.triggered).toBeNull()
  })

  it('reports full progress for a zero threshold', () => {
    expect(dwellProgress(DWELL_IDLE, 0)).toBe(1)
  })
})
