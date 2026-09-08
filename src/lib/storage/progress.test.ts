import { appendEvent, MAX_EVENTS, PROGRESS_KEY, readEvents, recordEvent, summarize, type KeyValueStore } from './progress'

const memoryStore = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('progress', () => {
  it('records and reads events through the store', () => {
    const store = memoryStore()
    recordEvent({ game: 'wave-pop', skill: 'colour', detail: 'Red' }, store, () => 123)
    expect(readEvents(store)).toEqual([{ game: 'wave-pop', skill: 'colour', detail: 'Red', at: 123 }])
  })

  it('ignores malformed or missing data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readEvents(memoryStore({ [PROGRESS_KEY]: '{not json' }))).toEqual([])
    expect(readEvents(memoryStore({ [PROGRESS_KEY]: JSON.stringify([{ nope: 1 }, { game: 'a', skill: 'b', at: 1 }]) }))).toHaveLength(1)
    expect(readEvents(null)).toEqual([])
    warn.mockRestore()
  })

  it('caps the log length', () => {
    const many = Array.from({ length: MAX_EVENTS }, (_, i) => ({ game: 'g', skill: 's', at: i }))
    const next = appendEvent(many, { game: 'g', skill: 's', at: 999 })
    expect(next).toHaveLength(MAX_EVENTS)
    expect(next[next.length - 1].at).toBe(999)
  })

  it('summarises per game and by top skills', () => {
    const summary = summarize([
      { game: 'a', skill: 'colour', at: 1 },
      { game: 'a', skill: 'colour', at: 2 },
      { game: 'b', skill: 'counting', at: 3 },
    ])
    expect(summary.totalEvents).toBe(3)
    expect(summary.perGame).toEqual({ a: 2, b: 1 })
    expect(summary.topSkills[0]).toEqual({ skill: 'colour', count: 2 })
  })

  it('does not throw when the store fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => recordEvent({ game: 'a', skill: 'b' }, broken)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
