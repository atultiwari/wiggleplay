import { renderHook } from '@testing-library/react'
import { useGameLoop } from './useGameLoop'

describe('useGameLoop', () => {
  let frames: FrameRequestCallback[]
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(performance, 'now').mockReturnValue(1000)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('calls the frame callback with a clamped delta', () => {
    const onFrame = vi.fn()
    renderHook(() => useGameLoop(onFrame, true))
    expect(frames).toHaveLength(1)
    frames[0](1016)
    expect(onFrame).toHaveBeenCalledWith(expect.closeTo(0.016, 3), 1016)
    frames[1](5000)
    expect(onFrame).toHaveBeenLastCalledWith(0.05, 5000)
  })

  it('does nothing while inactive and keeps running after a thrown frame', () => {
    const onFrame = vi.fn(() => {
      throw new Error('boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderHook(({ active }) => useGameLoop(onFrame, active), { initialProps: { active: false } })
    expect(frames).toHaveLength(0)
    rerender({ active: true })
    frames[0](1016)
    expect(errorSpy).toHaveBeenCalled()
    expect(frames).toHaveLength(2)
  })
})
