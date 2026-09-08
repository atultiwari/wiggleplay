import { useEffect, useState, type RefObject } from 'react'

export interface Size {
  readonly width: number
  readonly height: number
}

/** Observes an element's CSS size. */
export const useElementSize = (ref: RefObject<HTMLElement | null>): Size => {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () =>
      setSize({ width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * Sizes the canvas backing store for the device pixel ratio and returns a context
 * scaled so that game code can draw in CSS pixels.
 */
export const prepareCanvas = (canvas: HTMLCanvasElement, size: Size): CanvasRenderingContext2D | null => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const targetWidth = Math.round(size.width * dpr)
  const targetHeight = Math.round(size.height * dpr)
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}
