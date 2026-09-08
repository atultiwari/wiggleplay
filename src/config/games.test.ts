import { DEFAULT_FILTER, filterGames, findGame, GAMES } from './games'
import { GAME_COMPONENTS } from '../games/registry'

describe('games catalogue', () => {
  it('has unique ids and a component for every ready game', () => {
    const ids = GAMES.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    GAMES.filter((g) => g.status === 'ready').forEach((g) => expect(GAME_COMPONENTS[g.id]).toBeDefined())
  })

  it('finds games by id', () => {
    expect(findGame('air-paint')?.title).toBe('Air Painting')
    expect(findGame('nope')).toBeUndefined()
    expect(findGame(undefined)).toBeUndefined()
  })

  it('filters by category, age and interest', () => {
    expect(filterGames(GAMES, DEFAULT_FILTER)).toHaveLength(GAMES.length)
    const camera = filterGames(GAMES, { ...DEFAULT_FILTER, category: 'camera' })
    expect(camera.every((g) => g.category === 'camera')).toBe(true)
    const fruits = filterGames(GAMES, { ...DEFAULT_FILTER, interest: 'fruits' })
    expect(fruits.map((g) => g.id)).toContain('fruit-slice')
    const older = filterGames(GAMES, { ...DEFAULT_FILTER, ageBand: '4-5', category: 'voice' })
    expect(older).toHaveLength(0)
  })
})
