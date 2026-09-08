import type { Pointer } from '../../types/pointer'

const HALO_RADIUS: Readonly<Record<Pointer['kind'], number>> = { hand: 34, head: 48, foot: 30, body: 70 }
const DOT_RADIUS: Readonly<Record<Pointer['kind'], number>> = { hand: 14, head: 16, foot: 14, body: 0 }

/** Draws a friendly glowing cursor for a pointer: a halo on the part and a dot on the cursor. */
export const drawPointerCursor = (ctx: CanvasRenderingContext2D, pointer: Pointer, color = '#ffffff'): void => {
  ctx.save()
  ctx.globalAlpha = 0.22
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(pointer.palm.x, pointer.palm.y, HALO_RADIUS[pointer.kind], 0, Math.PI * 2)
  ctx.fill()

  const dot = DOT_RADIUS[pointer.kind]
  if (dot > 0) {
    ctx.globalAlpha = 0.9
    ctx.shadowColor = color
    ctx.shadowBlur = 18
    ctx.beginPath()
    ctx.arc(pointer.tip.x, pointer.tip.y, dot, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
