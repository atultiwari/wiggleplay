import { createSeededRng } from '../../lib/game/random'
import { configFromSettings, COUNT_TARGET, createFlyState, DEFAULT_FLY_CONFIG, PLANE_BASE_SIZE, planeX, spawnBalloon, stepFly } from './logic'

const size = { width: 1200, height: 700 }

describe('fly high', () => {
  it('spawns balloons off the right edge moving left', () => {
    const balloon = spawnBalloon(size.width, size.height, 1, createSeededRng(1))
    expect(balloon.x).toBeGreaterThan(size.width)
    expect(balloon.vx).toBeLessThan(0)
    expect(balloon.y).toBeGreaterThan(100)
  })

  it('eases the plane toward the target and clamps to the sky', () => {
    let state = createFlyState(size.height)
    for (let i = 0; i < 30; i += 1) state = stepFly(state, 0.05, { targetY: -500, ...size }).state
    expect(state.planeY).toBeGreaterThan(100)
    expect(state.planeY).toBeLessThan(200)
    for (let i = 0; i < 30; i += 1) state = stepFly(state, 0.05, { targetY: null, ...size }).state
    expect(state.planeY).toBeCloseTo(size.height / 2, 0)
  })

  it('collects a balloon the plane flies into and counts', () => {
    const balloon = { ...spawnBalloon(size.width, size.height, 1, createSeededRng(2)), x: planeX(size.width) + 40, y: size.height / 2 }
    const state = { ...createFlyState(size.height), balloons: [balloon], spawnInSec: 99, cloudInSec: 99 }
    const { state: next, events } = stepFly(state, 0.016, { targetY: null, ...size })
    expect(events.collected).toEqual([1])
    expect(next.balloons).toHaveLength(0)
    expect(next.total).toBe(1)
    expect(next.particles.length).toBeGreaterThan(0)
  })

  it('celebrates at ten and pauses spawning', () => {
    const balloon = { ...spawnBalloon(size.width, size.height, 1, createSeededRng(3)), x: planeX(size.width), y: size.height / 2 }
    const state = { ...createFlyState(size.height), balloons: [balloon], count: COUNT_TARGET - 1, spawnInSec: 0, cloudInSec: 99 }
    const { state: next, events } = stepFly(state, 0.016, { targetY: null, ...size })
    expect(events.celebrated).toBe(true)
    expect(next.count).toBe(0)
    expect(next.celebrationSec).toBeGreaterThan(0)
    expect(next.balloons).toHaveLength(0)
  })

  it('drops balloons and clouds that leave the screen and keeps spawning clouds', () => {
    const balloon = { ...spawnBalloon(size.width, size.height, 1, createSeededRng(4)), x: -200 }
    const state = { ...createFlyState(size.height), balloons: [balloon], clouds: [{ id: 9, x: -500, y: 200, size: 100, vx: -40 }], spawnInSec: 99, cloudInSec: 0 }
    const { state: next } = stepFly(state, 0.016, { targetY: null, ...size }, createSeededRng(5))
    expect(next.balloons).toHaveLength(0)
    expect(next.clouds).toHaveLength(1)
    expect(next.clouds[0].id).not.toBe(9)
  })

  it('maps settings', () => {
    const config = configFromSettings({ balloonIntervalSec: 2, speed: 1.5, planeSize: 2 })
    expect(config).toEqual({ balloonIntervalSec: 2, speedScale: 1.5, planeSize: PLANE_BASE_SIZE * 2 })
    const fast = spawnBalloon(size.width, size.height, 1, createSeededRng(6), config)
    const normal = spawnBalloon(size.width, size.height, 1, createSeededRng(6), DEFAULT_FLY_CONFIG)
    expect(fast.vx).toBeCloseTo(normal.vx * 1.5)
  })
})
