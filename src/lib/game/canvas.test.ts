import { renderHook } from '@testing-library/react'
import { prepareCanvas, useElementSize } from './canvas'

describe('prepareCanvas', () => {
  it('sizes the backing store by device pixel ratio and scales the context', () => {
    const setTransform = vi.fn()
    const canvas = document.createElement('canvas')
    canvas.getContext = vi.fn(() => ({ setTransform })) as unknown as typeof canvas.getContext
    vi.stubGlobal('devicePixelRatio', 2)
    const ctx = prepareCanvas(canvas, { width: 100, height: 50 })
    expect(canvas.width).toBe(200)
    expect(canvas.height).toBe(100)
    expect(ctx).not.toBeNull()
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    vi.unstubAllGlobals()
  })

  it('returns null when the 2d context is unavailable', () => {
    const canvas = document.createElement('canvas')
    canvas.getContext = vi.fn(() => null) as unknown as typeof canvas.getContext
    expect(prepareCanvas(canvas, { width: 10, height: 10 })).toBeNull()
  })
})

describe('useElementSize', () => {
  it('reports the element size and observes resizes', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe
        disconnect = disconnect
      },
    )
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientWidth', { value: 320 })
    Object.defineProperty(element, 'clientHeight', { value: 180 })
    const ref = { current: element }
    const { result, unmount } = renderHook(() => useElementSize(ref))
    expect(result.current).toEqual({ width: 320, height: 180 })
    expect(observe).toHaveBeenCalledWith(element)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
