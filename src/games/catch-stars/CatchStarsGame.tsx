import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawHandCursor } from '../../components/game/drawHand'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCatch, playCheer } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { recordEvent } from '../../lib/storage/progress'
import { BASKET, basketTop, createCatchState, stepCatch, type CatchState } from './logic'

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

type Images = Readonly<Record<'star' | 'mascot', HTMLImageElement>>

const drawSky = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, 'rgba(24, 16, 64, 0.75)')
  gradient.addColorStop(1, 'rgba(90, 60, 160, 0.55)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

const drawBasket = (ctx: CanvasRenderingContext2D, state: CatchState, height: number, mascot: HTMLImageElement) => {
  const top = basketTop(height)
  const x = state.basketX
  const mascotSize = BASKET.height * 1.5
  ctx.drawImage(mascot, x - mascotSize / 2, top - mascotSize * 0.62, mascotSize, mascotSize)
  ctx.save()
  ctx.fillStyle = '#c97b3a'
  ctx.strokeStyle = '#8a4b1c'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(x - BASKET.width / 2, top)
  ctx.lineTo(x + BASKET.width / 2, top)
  ctx.lineTo(x + BASKET.width / 2 - 24, top + BASKET.height)
  ctx.lineTo(x - BASKET.width / 2 + 24, top + BASKET.height)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 3
  for (let i = 1; i < 5; i += 1) {
    const y = top + (BASKET.height / 5) * i
    ctx.beginPath()
    ctx.moveTo(x - BASKET.width / 2 + 6 * i, y)
    ctx.lineTo(x + BASKET.width / 2 - 6 * i, y)
    ctx.stroke()
  }
  ctx.restore()
}

const drawStars = (ctx: CanvasRenderingContext2D, state: CatchState, star: HTMLImageElement) => {
  state.stars.forEach((s) => {
    ctx.save()
    ctx.translate(s.x, s.y)
    ctx.rotate(s.rotation)
    ctx.drawImage(star, -s.size / 2, -s.size / 2, s.size, s.size)
    ctx.restore()
  })
}

const CatchStarsStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<CatchState>(createCatchState(stage.size.width))
  const [images, setImages] = useState<Images | null>(null)
  const [count, setCount] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ star: ART.star, mascot: ART.mascot })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[catch-stars] images failed', error))
    return () => {
      cancelled = true
    }
  }, [])

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0 || !images) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    const hand = stage.handsRef.current[0]

    if (stage.active) {
      const { state, events } = stepCatch(stateRef.current, dtSec, {
        targetX: hand ? hand.palm.x : null,
        width,
        height,
      })
      stateRef.current = state
      events.caught.forEach((n) => {
        playCatch()
        say(NUMBER_WORDS[n - 1] ?? String(n))
        recordEvent({ game: 'catch-stars', skill: 'counting', detail: String(n) })
      })
      if (events.celebrated) {
        playCheer()
        say('Ten stars! Hooray!')
        recordEvent({ game: 'catch-stars', skill: 'counting', detail: 'ten-complete' })
      }
      if (events.caught.length > 0 || events.celebrated) {
        setCount(state.count)
        setTotal(state.total)
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    drawSky(ctx, width, height)
    drawStars(ctx, state, images.star)
    drawBasket(ctx, state, height, images.mascot)
    drawParticles(ctx, state.particles)
    if (hand) drawHandCursor(ctx, hand, '#ffd60a')
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'count', text: `⭐ ${count} / 10`, accent: true },
        { id: 'total', text: `Total ${total}` },
      ]}
    />
  )
}

const CatchStarsGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game} cameraOpacity={0.5}>
    {(stage) => <CatchStarsStage stage={stage} />}
  </GameShell>
)

export default CatchStarsGame
