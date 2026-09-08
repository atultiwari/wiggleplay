import { useRef, useState } from 'react'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawHandCursor } from '../../components/game/drawHand'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { PENTATONIC, playNote, playSparkle } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { DWELL_IDLE, dwellProgress, updateDwell, type DwellState } from '../../lib/game/dwell'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { recordEvent } from '../../lib/storage/progress'
import { isFist } from '../../lib/hands/features'
import {
  advanceHue,
  brushColor,
  CLEAR_ID,
  clearPaint,
  extendStroke,
  hitSwatch,
  INITIAL_PAINT_STATE,
  liftBrush,
  PALETTE,
  paletteLayout,
  rainbowHex,
  RAINBOW_ID,
  selectColor,
  type PaintState,
  type Stroke,
  type Swatch,
} from './logic'

const DWELL_MS = 700
const NOTE_EVERY_PX = 60

interface FrameState {
  readonly paint: PaintState
  readonly dwell: DwellState
  readonly particles: readonly Particle[]
  readonly distanceSinceNote: number
}

const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
  if (stroke.points.length === 0) return
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  const [first, ...rest] = stroke.points
  ctx.moveTo(first.x, first.y)
  if (rest.length === 0) ctx.lineTo(first.x + 0.1, first.y)
  rest.forEach((p) => ctx.lineTo(p.x, p.y))
  ctx.stroke()
}

const drawSwatch = (ctx: CanvasRenderingContext2D, swatch: Swatch, hue: number, selected: boolean, progress: number) => {
  ctx.save()
  ctx.beginPath()
  ctx.arc(swatch.x, swatch.y, swatch.r, 0, Math.PI * 2)
  if (swatch.id === CLEAR_ID) {
    ctx.fillStyle = '#ffffff'
  } else if (swatch.id === RAINBOW_ID) {
    const gradient = ctx.createLinearGradient(swatch.x - swatch.r, swatch.y, swatch.x + swatch.r, swatch.y)
    ;[0, 0.2, 0.4, 0.6, 0.8, 1].forEach((stop) => gradient.addColorStop(stop, rainbowHex(hue + stop * 300)))
    ctx.fillStyle = gradient
  } else {
    ctx.fillStyle = PALETTE.find((c) => c.id === swatch.id)?.hex ?? '#fff'
  }
  ctx.shadowColor = 'rgba(0,0,0,0.25)'
  ctx.shadowBlur = 10
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.lineWidth = selected ? 6 : 3
  ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.7)'
  ctx.stroke()
  if (swatch.id === CLEAR_ID) {
    ctx.font = `${swatch.r * 1.1}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('🧽', swatch.x, swatch.y + 2)
  }
  if (progress > 0) {
    ctx.beginPath()
    ctx.arc(swatch.x, swatch.y, swatch.r + 8, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2)
    ctx.lineWidth = 6
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
  ctx.restore()
}

const AirPaintStage = ({ stage }: { readonly stage: GameStage }) => {
  const frameRef = useRef<FrameState>({
    paint: INITIAL_PAINT_STATE,
    dwell: DWELL_IDLE,
    particles: [],
    distanceSinceNote: 0,
  })
  const lastTipRef = useRef<{ x: number; y: number } | null>(null)
  const [colorName, setColorName] = useState('Blue')

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    const layout = paletteLayout(width)
    const hands = stage.handsRef.current
    const hand = hands[0]
    const previous = frameRef.current

    let paint = { ...previous.paint, hue: advanceHue(previous.paint.hue, dtSec) }
    let particles = stepParticles(previous.particles, dtSec)
    let distanceSinceNote = previous.distanceSinceNote
    let dwell = previous.dwell

    if (stage.active && hand) {
      const target = hitSwatch(layout, hand.tip)
      const dwellUpdate = updateDwell(previous.dwell, target, dtSec * 1000, DWELL_MS)
      dwell = dwellUpdate.state
      if (dwellUpdate.triggered === CLEAR_ID) {
        paint = clearPaint(paint)
        playSparkle()
        say('All clean!')
        recordEvent({ game: 'air-paint', skill: 'cause-effect', detail: 'clear' })
      } else if (dwellUpdate.triggered) {
        paint = selectColor(paint, dwellUpdate.triggered)
        const name = PALETTE.find((c) => c.id === dwellUpdate.triggered)?.name ?? ''
        setColorName(name)
        playSparkle()
        say(name)
        recordEvent({ game: 'air-paint', skill: 'colour', detail: dwellUpdate.triggered })
      }

      const onPalette = target !== null
      const penDown = !onPalette && !isFist(hand.points)
      if (penDown) {
        const moved = lastTipRef.current ? Math.hypot(hand.tip.x - lastTipRef.current.x, hand.tip.y - lastTipRef.current.y) : 0
        paint = extendStroke(paint, hand.tip)
        distanceSinceNote += moved
        if (distanceSinceNote > NOTE_EVERY_PX) {
          distanceSinceNote = 0
          const index = Math.floor((1 - hand.tip.y / height) * (PENTATONIC.length - 1))
          playNote(PENTATONIC[Math.max(0, Math.min(PENTATONIC.length - 1, index))])
          particles = [...particles, ...spawnBurst(hand.tip, { count: 2, colors: [brushColor(paint)], speed: [20, 90], size: [3, 7], life: [0.3, 0.6], gravity: 60 })]
        }
      } else {
        paint = liftBrush(paint)
      }
      lastTipRef.current = hand.tip
    } else {
      paint = liftBrush(paint)
      dwell = DWELL_IDLE
      lastTipRef.current = null
    }

    frameRef.current = { paint, dwell, particles, distanceSinceNote }

    ctx.clearRect(0, 0, width, height)
    paint.strokes.forEach((stroke) => drawStroke(ctx, stroke))
    if (paint.current) drawStroke(ctx, paint.current)
    drawParticles(ctx, particles)
    layout.forEach((swatch) =>
      drawSwatch(ctx, swatch, paint.hue, swatch.id === paint.colorId, dwell.targetId === swatch.id ? dwellProgress(dwell, DWELL_MS) : 0),
    )
    if (hand) drawHandCursor(ctx, hand, brushColor(paint))
  }, stage.size.width > 0)

  return <Hud badges={[{ id: 'color', text: `🎨 ${colorName}`, accent: true }]} />
}

const AirPaintGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game} cameraOpacity={0.35}>
    {(stage) => <AirPaintStage stage={stage} />}
  </GameShell>
)

export default AirPaintGame
