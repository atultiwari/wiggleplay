import { createThrottledSpeaker, say } from './voice'

describe('voice', () => {
  it('returns false when speech synthesis is missing', () => {
    expect(say('hello')).toBe(false)
  })

  it('speaks through speechSynthesis when present', () => {
    const speak = vi.fn()
    const cancel = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => [], addEventListener: vi.fn() })
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string
      constructor(text: string) {
        this.text = text
      }
    })
    expect(say('hi there')).toBe(true)
    expect(cancel).toHaveBeenCalled()
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi there' }))
    vi.unstubAllGlobals()
  })

  it('throttles repeated speech', () => {
    let now = 0
    const speaker = createThrottledSpeaker(500, () => now)
    expect(speaker('a')).toBe(false)
    now = 200
    expect(speaker('b')).toBe(false)
    now = 700
    expect(speaker('c')).toBe(false)
  })
})
