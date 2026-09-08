import { useRef, useState } from 'react'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawPointerCursor } from '../../components/game/drawPointer'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { playCheer, playPop } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { bubbleDrawX, configFromSettings, createPopState, stepPop, type Bubble, type PopState } from './logic'

const speakColour = createThrottledSpeaker(900)

const drawBubble = (ctx: CanvasRenderingContext2D, bubble: Bubble, timeSec: number) => {
  const x = bubbleDrawX(bubble, timeSec)
  const { y, r } = bubble
  ctx.save()
  const gradient = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r)
  gradient.addColorStop(0, 'rgba(255,255,255,0.85)')
  gradient.addColorStop(0.35, `${bubble.color.hex}aa`)
  gradient.addColorStop(1, `${bubble.color.hex}55`)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.beginPath()
  ctx.ellipse(x - r * 0.4, y - r * 0.45, r * 0.18, r * 0.1, -Math.PI / 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

const WavePopStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<PopState>(createPopState())
  const settingsRef = useSettingsRef()
  const [popped, setPopped] = useState(0)

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    const hands = stage.pointersRef.current

    if (stage.active) {
      const config = configFromSettings(settingsRef.current.wavePop)
      const { state, events } = stepPop(stateRef.current, dtSec, { hands, width, height, config })
      stateRef.current = state
      if (events.popped.length > 0) {
        playPop()
        const first = events.popped[0]
        speakColour(first.color.name)
        events.popped.forEach((b) => recordEvent({ game: 'wave-pop', skill: 'colour', detail: b.color.name }))
        setPopped(state.popped)
      }
      if (events.milestone) {
        playCheer()
        say(`Wow! ${state.popped} bubbles!`)
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    state.bubbles.forEach((b) => drawBubble(ctx, b, state.timeSec))
    drawParticles(ctx, state.particles)
    if (settingsRef.current.global.showHandCursor) hands.forEach((hand) => drawPointerCursor(ctx, hand, '#5cc8ff'))
  }, stage.size.width > 0)

  return <Hud badges={[{ id: 'popped', text: `🫧 ${popped}`, accent: true }]} />
}

const WavePopGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>
    {(stage) => <WavePopStage stage={stage} />}
  </GameShell>
)

export default WavePopGame
