import { makePointer } from '../../test/hands'
import { INTERACTION_MODE_IDS, INTERACTION_MODES, modeInfo } from './modes'
import { allTouchPoints, primaryPointer } from './pointer'

describe('interaction modes', () => {
  it('lists every mode with a model', () => {
    expect(INTERACTION_MODE_IDS).toEqual(['body', 'hand', 'finger', 'head'])
    INTERACTION_MODES.forEach((m) => expect(['hand', 'pose']).toContain(m.model))
    expect(modeInfo('finger').model).toBe('hand')
    expect(modeInfo('body').model).toBe('pose')
  })
})

describe('primaryPointer', () => {
  const body = makePointer(1, 'body', { x: 1, y: 1 })
  const hand = makePointer(2, 'hand', { x: 2, y: 2 })
  const head = makePointer(3, 'head', { x: 3, y: 3 })

  it('honours preference order and falls back to the first pointer', () => {
    expect(primaryPointer([body, hand, head], ['hand', 'body'])).toBe(hand)
    expect(primaryPointer([body, hand, head], ['foot', 'head'])).toBe(head)
    expect(primaryPointer([body, hand], ['foot'])).toBe(body)
    expect(primaryPointer([], ['hand'])).toBeUndefined()
  })

  it('collects touch points across pointers', () => {
    expect(allTouchPoints([body, hand])).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }])
  })
})
