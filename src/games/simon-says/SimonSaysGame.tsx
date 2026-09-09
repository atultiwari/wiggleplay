import { useRef, useState } from 'react'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { playCatch, playCheer } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { SKELETON_LINKS } from '../wiggle-mirror/logic'
import { configFromSettings, createSimonState, frameFromLandmarks, holdProgress, MOVE_INFO, stepSimon, type SimonState } from './logic'

const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']

const drawCard = (ctx: CanvasRenderingContext2D, width: number, height: number, state: SimonState) => {
  const info = MOVE_INFO[state.move]
  const cardWidth = Math.min(width * 0.86, 720)
  const cardHeight = Math.min(height * 0.26, 190)
  const x = (width - cardWidth) / 2
  const y = height * 0.1
  const celebrating = state.phase === 'celebrating'
  ctx.save()
  ctx.fillStyle = celebrating ? 'rgba(61, 220, 132, 0.92)' : 'rgba(255, 255, 255, 0.9)'
  ctx.beginPath()
  ctx.roundRect(x, y, cardWidth, cardHeight, 28)
  ctx.fill()
  const emojiSize = Math.round(cardHeight * 0.55)
  ctx.font = `${emojiSize}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const bounce = celebrating ? Math.sin(state.phaseSec * 12) * 8 : 0
  ctx.fillText(info.emoji, x + cardHeight * 0.25, y + cardHeight / 2 + bounce)
  ctx.font = `700 ${Math.round(cardHeight * 0.3)}px system-ui, sans-serif`
  ctx.fillStyle = '#1b1533'
  ctx.fillText(celebrating ? info.praise : state.phase === 'resting' ? 'Get ready…' : info.label, x + cardHeight * 1.05, y + cardHeight / 2)
  if (state.phase === 'waiting') {
    const progress = holdProgress(state)
    ctx.fillStyle = 'rgba(27, 21, 51, 0.15)'
    ctx.fillRect(x + 24, y + cardHeight - 22, cardWidth - 48, 10)
    ctx.fillStyle = '#3ddc84'
    ctx.fillRect(x + 24, y + cardHeight - 22, (cardWidth - 48) * progress, 10)
  }
  ctx.restore()
}

const SimonStage = ({ stage }: { readonly stage: GameStage }) => {
  const settingsRef = useSettingsRef()
  const stateRef = useRef<SimonState | null>(null)
  const particlesRef = useRef<readonly Particle[]>([])
  const [done, setDone] = useState(0)

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    const settings = settingsRef.current.simonSays
    const config = configFromSettings(settings)
    if (!stateRef.current) stateRef.current = createSimonState(config)
    const landmarks = stage.poseRef.current
    const frame = frameFromLandmarks(landmarks)

    if (stage.active) {
      const { state, events } = stepSimon(stateRef.current, dtSec, { frame, config })
      stateRef.current = state
      if (events.asked) say(MOVE_INFO[events.asked].say)
      if (events.done) {
        playCheer()
        playCatch()
        say(MOVE_INFO[events.done].praise)
        recordEvent({ game: 'simon-says', skill: 'body-parts', detail: events.done })
        setDone(state.done)
        particlesRef.current = [...particlesRef.current, ...spawnBurst({ x: width / 2, y: height * 0.35 }, { count: 90, colors: CONFETTI, speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 })]
      }
      if (events.skipped) say("Let's try a different one!")
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    if (settings.showSkeleton && landmarks) {
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 4
      ctx.lineCap = 'round'
      SKELETON_LINKS.forEach(([a, b]) => {
        if (landmarks[a].visibility < 0.5 || landmarks[b].visibility < 0.5) return
        ctx.beginPath()
        ctx.moveTo((1 - landmarks[a].x) * width, landmarks[a].y * height)
        ctx.lineTo((1 - landmarks[b].x) * width, landmarks[b].y * height)
        ctx.stroke()
      })
      ctx.restore()
    }
    drawCard(ctx, width, height, state)
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawParticles(ctx, particlesRef.current)
  }, stage.size.width > 0)

  return <Hud badges={[{ id: 'done', text: `⭐ ${done}`, accent: true }]} />
}

const SimonSaysGame = ({ game }: { readonly game: GameMeta }) => <GameShell game={game}>{(stage) => <SimonStage stage={stage} />}</GameShell>

export default SimonSaysGame
