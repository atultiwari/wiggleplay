import type { HandPose } from '../../types/hand'

/** Draws a friendly glowing cursor on the fingertip and a faint palm halo. */
export const drawHandCursor = (ctx: CanvasRenderingContext2D, hand: HandPose, color = '#ffffff'): void => {
  ctx.save()
  ctx.globalAlpha = 0.25
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(hand.palm.x, hand.palm.y, 34, 0, Math.PI * 2)
  ctx.fill()

  ctx.globalAlpha = 0.9
  ctx.shadowColor = color
  ctx.shadowBlur = 18
  ctx.beginPath()
  ctx.arc(hand.tip.x, hand.tip.y, 14, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
