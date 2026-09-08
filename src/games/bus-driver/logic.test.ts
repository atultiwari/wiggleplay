import { createSeededRng } from '../../lib/game/random'
import {
  BOARD_SEC,
  boardingProgress,
  configFromSettings,
  COUNT_TARGET,
  createBusState,
  DEFAULT_BUS_CONFIG,
  DEPART_SEC,
  MAX_WAITING,
  PASSENGER_KINDS,
  spawnPassenger,
  stepBus,
  type BusState,
  type Passenger,
} from './logic'

const size = { width: 1200, height: 700 }
const waiting = (x: number, id = 1): Passenger => ({ id, kind: 'dog', x, size: 110, boardingSec: -1 })

describe('bus driver', () => {
  it('spawns passengers spaced apart', () => {
    const rng = createSeededRng(1)
    const first = spawnPassenger(size.width, [], 1, rng)
    expect(PASSENGER_KINDS).toContain(first.kind)
    const second = spawnPassenger(size.width, [first], 2, rng)
    expect(Math.abs(second.x - first.x)).toBeGreaterThan(150)
  })

  it('follows the target and boards a passenger under the door', () => {
    let state: BusState = { ...createBusState(size.width), passengers: [waiting(300)], spawnInSec: 99 }
    let boarded: number[] = []
    for (let i = 0; i < 40; i += 1) {
      const step = stepBus(state, 0.05, { targetX: 300, ...size })
      state = step.state
      boarded = [...boarded, ...step.events.boarded.map((b) => b.count)]
    }
    expect(boarded).toEqual([1])
    expect(state.aboard).toBe(1)
    expect(state.total).toBe(1)
    expect(state.passengers).toHaveLength(0)
  })

  it('animates boarding progress', () => {
    expect(boardingProgress(waiting(0))).toBe(0)
    expect(boardingProgress({ ...waiting(0), boardingSec: BOARD_SEC / 2 })).toBeCloseTo(0.5)
    expect(boardingProgress({ ...waiting(0), boardingSec: 9 })).toBe(1)
  })

  it('departs at ten, drives off, then returns to the middle', () => {
    const state = { ...createBusState(size.width), passengers: [waiting(600)], aboard: COUNT_TARGET - 1, spawnInSec: 99 }
    const { state: next, events } = stepBus(state, 0.016, { targetX: 600, ...size })
    expect(events.departed).toBe(true)
    expect(next.aboard).toBe(0)
    expect(next.departingSec).toBe(DEPART_SEC)
    expect(next.passengers).toHaveLength(0)
    const driving = stepBus(next, 0.5, { targetX: 100, ...size }).state
    expect(driving.busX).toBeGreaterThan(next.busX)
    const back = stepBus(driving, DEPART_SEC, { targetX: 100, ...size }).state
    expect(back.departingSec).toBe(0)
    expect(back.busX).toBe(size.width / 2)
  })

  it('caps waiting passengers and maps settings', () => {
    let state = createBusState(size.width)
    for (let i = 0; i < 100; i += 1) state = stepBus(state, 0.1, { targetX: -9999, ...size }, createSeededRng(i)).state
    expect(state.passengers.filter((p) => p.boardingSec < 0).length).toBeLessThanOrEqual(MAX_WAITING)
    expect(configFromSettings({ passengerIntervalSec: 3, busSize: 1.5 })).toEqual({ passengerIntervalSec: 3, busWidth: DEFAULT_BUS_CONFIG.busWidth * 1.5 })
  })
})
