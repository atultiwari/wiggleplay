import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCheer, playSlice } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import {
  configFromSettings,
  createSliceState,
  FRUIT_INFO,
  stepSlice,
  type BladeTrail,
  type Fruit,
  type FruitHalf,
  type FruitKind,
  type SliceState,
} from './logic'

type FruitImages = Readonly<Record<FruitKind, HTMLImageElement>>

const speakFruit = createThrottledSpeaker(700)

const drawFruit = (ctx: CanvasRenderingContext2D, fruit: Fruit, image: HTMLImageElement) => {
  ctx.save()
  ctx.translate(fruit.x, fruit.y)
  ctx.rotate(fruit.rotation)
  ctx.drawImage(image, -fruit.r, -fruit.r, fruit.r * 2, fruit.r * 2)
  ctx.restore()
}

const drawHalf = (ctx: CanvasRenderingContext2D, half: FruitHalf, image: HTMLImageElement) => {
  ctx.save()
  ctx.globalAlpha = Math.min(1, half.life / 0.4)
  ctx.translate(half.x, half.y)
  ctx.rotate(half.rotation)
  ctx.beginPath()
  if (half.side === 'left') ctx.rect(-half.r, -half.r, half.r, half.r * 2)
  else ctx.rect(0, -half.r, half.r, half.r * 2)
  ctx.clip()
  ctx.drawImage(image, -half.r, -half.r, half.r * 2, half.r * 2)
  ctx.restore()
}

const drawTrail = (ctx: CanvasRenderingContext2D, trail: BladeTrail) => {
  if (trail.points.length < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = '#ffffff'
  ctx.shadowBlur = 16
  trail.points.forEach((p, i) => {
    if (i === 0) return
    const previous = trail.points[i - 1]
    const t = i / trail.points.length
    ctx.strokeStyle = `rgba(255,255,255,${0.15 + 0.75 * t})`
    ctx.lineWidth = 4 + 14 * t
    ctx.beginPath()
    ctx.moveTo(previous.x, previous.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  })
  ctx.restore()
}

const FruitSliceStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<SliceState>(createSliceState())
  const settingsRef = useSettingsRef()
  const [images, setImages] = useState<FruitImages | null>(null)
  const [sliced, setSliced] = useState(0)
  const [lastFruit, setLastFruit] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    loadImageMap({
      apple: ART.apple,
      banana: ART.banana,
      orange: ART.orange,
      watermelon: ART.watermelon,
      strawberry: ART.strawberry,
      grapes: ART.grapes,
    })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[fruit-slice] images failed', error))
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
    const hands = stage.handsRef.current

    if (stage.active) {
      const config = configFromSettings(settingsRef.current.fruitSlice)
      const { state, events } = stepSlice(stateRef.current, dtSec, { hands, width, height, config })
      stateRef.current = state
      if (events.sliced.length > 0) {
        playSlice()
        const info = FRUIT_INFO[events.sliced[0].kind]
        speakFruit(info.name)
        setLastFruit(info.name)
        setSliced(state.sliced)
        events.sliced.forEach((f) => recordEvent({ game: 'fruit-slice', skill: 'fruit', detail: f.kind }))
      }
      if (events.milestone) {
        playCheer()
        say('Yummy!')
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    state.halves.forEach((h) => drawHalf(ctx, h, images[h.kind]))
    state.fruits.forEach((f) => drawFruit(ctx, f, images[f.kind]))
    drawParticles(ctx, state.particles)
    state.trails.forEach((t) => drawTrail(ctx, t))
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'sliced', text: `🍉 ${sliced}`, accent: true },
        ...(lastFruit ? [{ id: 'last', text: lastFruit }] : []),
      ]}
    />
  )
}

const FruitSliceGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game} cameraOpacity={0.55}>
    {(stage) => <FruitSliceStage stage={stage} />}
  </GameShell>
)

export default FruitSliceGame
