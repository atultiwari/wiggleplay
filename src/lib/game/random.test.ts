import { createSeededRng, pickOne, randomBetween, randomInt } from './random'

describe('random', () => {
  it('is deterministic for a seed', () => {
    const a = createSeededRng(42)
    const b = createSeededRng(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
    seqA.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    })
  })

  it('scales into ranges', () => {
    expect(randomBetween(10, 20, () => 0)).toBe(10)
    expect(randomBetween(10, 20, () => 0.5)).toBe(15)
    expect(randomInt(1, 3, () => 0.999)).toBe(3)
    expect(randomInt(1, 3, () => 0)).toBe(1)
  })

  it('picks from lists and refuses empty ones', () => {
    expect(pickOne(['a', 'b', 'c'], () => 0.99)).toBe('c')
    expect(pickOne(['a', 'b', 'c'], () => 0)).toBe('a')
    expect(() => pickOne([], () => 0)).toThrow('empty')
  })
})
