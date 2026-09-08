import { isReady, startCooldown, tickCooldown } from './timers'

describe('timers', () => {
  it('counts down and never goes negative', () => {
    const cd = startCooldown(1)
    expect(isReady(cd)).toBe(false)
    const half = tickCooldown(cd, 0.5)
    expect(half.remainingSec).toBe(0.5)
    const done = tickCooldown(half, 5)
    expect(done.remainingSec).toBe(0)
    expect(isReady(done)).toBe(true)
  })
})
