import { describe, expect, it } from 'vitest'
import { CELEBRATE_SEC, createTraceState, fitBox, HINT_SEC, nextGem, sampleGems, stepTrace, traceProgress, type TraceInput, type TraceState } from './logic'
import { EASY_SHAPES, HARDER_SHAPES, LETTERS } from './paths'

const W = 1200
const H = 700
const lineAcross = EASY_SHAPES[0]
const idle: TraceInput = { touches: [], width: W, height: H }
const run = (state: TraceState, seconds: number, input: TraceInput, dt = 0.05) => {
  let current = state
  for (let t = 0; t < seconds; t += dt) current = stepTrace(current, dt, input).state
  return current
}

describe('trace paths', () => {
  it('defines all 26 letters and every path stays inside the box', () => {
    expect(LETTERS.map((l) => l.label).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    for (const path of [...LETTERS, ...EASY_SHAPES, ...HARDER_SHAPES]) {
      expect(path.strokes.length).toBeGreaterThan(0)
      for (const stroke of path.strokes) {
        expect(stroke.length).toBeGreaterThan(1)
        for (const p of stroke) {
          expect(p.x).toBeGreaterThanOrEqual(0)
          expect(p.x).toBeLessThanOrEqual(100)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThanOrEqual(100)
        }
      }
    }
  })

  it('samples gems along a stroke including both ends, spaced as asked', () => {
    const box = fitBox(W, H)
    const gems = sampleGems(lineAcross, box, box.size * 0.2)
    expect(gems.length).toBe(5)
    expect(gems[0].x).toBeCloseTo(box.x + box.size * 0.1)
    expect(gems[gems.length - 1].x).toBeCloseTo(box.x + box.size * 0.9)
    expect(gems.every((g) => Math.abs(g.y - (box.y + box.size / 2)) < 0.01)).toBe(true)
  })

  it('places fewer, bigger gems when the size setting grows', () => {
    const small = createTraceState(lineAcross, W, H, { gemSize: 0.7 }).gems.length
    const big = createTraceState(lineAcross, W, H, { gemSize: 1.5 }).gems.length
    expect(small).toBeGreaterThan(big)
  })
})

describe('tracing', () => {
  it('collects gems in order along the finger and completes the path', () => {
    let state = createTraceState(lineAcross, W, H)
    const total = state.gems.length
    expect(nextGem(state)?.id).toBe(0)
    // Touch the last gem first: too far ahead, nothing happens.
    const last = state.gems[total - 1]
    expect(stepTrace(state, 0.05, { ...idle, touches: [last] }).events.collected).toHaveLength(0)
    let completed = false
    for (const gem of state.gems) {
      const step = stepTrace(state, 0.05, { ...idle, touches: [{ x: gem.x + 4, y: gem.y - 3 }] })
      state = step.state
      completed = completed || step.events.completed
    }
    expect(completed).toBe(true)
    expect(traceProgress(state)).toBe(1)
    expect(state.completeSec).toBe(CELEBRATE_SEC)
    expect(state.completed).toBe(1)
    let advance = false
    let current = state
    for (let t = 0; t < CELEBRATE_SEC + 0.1 && !advance; t += 0.05) {
      const step = stepTrace(current, 0.05, idle)
      current = step.state
      advance = step.events.advance
    }
    expect(advance).toBe(true)
  })

  it('lets a wobbly finger skip a gem or two but not race ahead', () => {
    const state = createTraceState(lineAcross, W, H)
    const skipTwo = stepTrace(state, 0.05, { ...idle, touches: [state.gems[2]] })
    expect(skipTwo.events.collected.map((g) => g.id)).toEqual([2])
    expect(skipTwo.state.next).toBe(0)
    const back = stepTrace(skipTwo.state, 0.05, { ...idle, touches: [state.gems[0], state.gems[1]] })
    expect(back.state.next).toBe(3)
  })

  it('nudges after a long idle and keeps a short finger trail', () => {
    const state = createTraceState(lineAcross, W, H)
    let hinted = false
    let current = state
    for (let t = 0; t < HINT_SEC + 0.2 && !hinted; t += 0.05) {
      const step = stepTrace(current, 0.05, idle)
      current = step.state
      hinted = step.events.hint
    }
    expect(hinted).toBe(true)
    const touched = run(state, 2, { ...idle, touches: [{ x: 5, y: 5 }] })
    expect(touched.trail.length).toBeLessThanOrEqual(14)
    expect(touched.trail.length).toBeGreaterThan(0)
  })
})
