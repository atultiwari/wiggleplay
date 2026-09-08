export type Rng = () => number

export const randomBetween = (min: number, max: number, rng: Rng = Math.random): number =>
  min + (max - min) * rng()

export const randomInt = (min: number, maxInclusive: number, rng: Rng = Math.random): number =>
  Math.floor(randomBetween(min, maxInclusive + 1, rng))

export const pickOne = <T>(items: readonly T[], rng: Rng = Math.random): T => {
  if (items.length === 0) throw new Error('pickOne: empty list')
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

/** Deterministic PRNG (mulberry32) for tests and reproducible demos. */
export const createSeededRng = (seed: number): Rng => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
