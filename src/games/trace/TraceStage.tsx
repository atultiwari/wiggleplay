import { useRef, useState } from 'react'
import { Hud } from '../../components/game/Hud'
import type { ActivityStage } from '../../components/game/ActivityShell'
import { playCatch, playCheer, playSparkle } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { recordEvent } from '../../lib/storage/progress'
import { createTraceState, nextGem, stepTrace, traceProgress, type Gem, type TraceConfig, type TraceState } from '../../lib/trace/logic'
import type { TracePath } from '../../lib/trace/paths'

export interface TraceStageProps {
  readonly stage: ActivityStage
  readonly gameId: string
  readonly skill: string
  readonly paths: readonly TracePath[]
  readonly config: TraceConfig
  /** Spoken when a new path appears. */
  readonly intro: (path: TracePath) => string
  /** Spoken when a path is finished; empty string to stay quiet. */
  readonly outro: (path: TracePath) => string
  readonly gemStyle: 'diamond' | 'ball'
  readonly accent: string
  readonly background: readonly [string, string]
  readonly hudEmoji: string
}

const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']
const GEM_COLORS = ['#5cc8ff', '#ff7ad9', '#ffd23f', '#7cf29c', '#c58bff']
const speakHint = createThrottledSpeaker(4000)

const drawGem = (ctx: CanvasRenderingContext2D, gem: Gem, radius: number, style: 'diamond' | 'ball', glow: number, time: number) => {
  const color = GEM_COLORS[gem.id % GEM_COLORS.length]
  const r = radius * (1 + glow * 0.18 * Math.sin(time * 6))
  ctx.save()
  ctx.translate(gem.x, gem.y)
  if (glow > 0) {
    ctx.shadowColor = color
    ctx.shadowBlur = 24 * glow
  }
  if (style === 'diamond') {
    ctx.rotate(Math.PI / 4)
    const g = ctx.createLinearGradient(-r, -r, r, r)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.35, color)
    g.addColorStop(1, '#4b3f8f')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5, r * 0.18)
    ctx.fill()
    ctx.rotate(-Math.PI / 4)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath()
    ctx.ellipse(-r * 0.25, -r * 0.3, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.3, color)
    g.addColorStop(1, '#3b2f7a')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

const drawScene = (ctx: CanvasRenderingContext2D, width: number, height: number, state: TraceState, props: TraceStageProps, particles: readonly Particle[], time: number) => {
  const bg = ctx.createLinearGradient(0, 0, 0, height)
  bg.addColorStop(0, props.background[0])
  bg.addColorStop(1, props.background[1])
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const gemRadius = state.box.size * 0.045 * props.config.gemSize
  const guideWidth = state.box.size * 0.09 * props.config.gemSize
  const celebrating = state.completeSec > 0
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  state.guides.forEach((guide, i) => {
    const done = state.gems.filter((g) => g.stroke === i).every((g) => g.collected)
    ctx.strokeStyle = done || celebrating ? props.accent : 'rgba(255,255,255,0.75)'
    ctx.lineWidth = guideWidth
    ctx.beginPath()
    guide.forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
    ctx.strokeStyle = 'rgba(27,21,51,0.28)'
    ctx.lineWidth = Math.max(3, guideWidth * 0.12)
    ctx.setLineDash([guideWidth * 0.3, guideWidth * 0.45])
    ctx.beginPath()
    guide.forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
    ctx.setLineDash([])
  })
  ctx.restore()

  // Finger trail: a soft comet behind the child's touch.
  if (state.trail.length > 1) {
    ctx.save()
    ctx.lineCap = 'round'
    state.trail.forEach((p, i) => {
      if (i === 0) return
      const a = i / state.trail.length
      ctx.strokeStyle = `rgba(255,255,255,${0.15 + a * 0.6})`
      ctx.lineWidth = 6 + a * 22
      ctx.beginPath()
      ctx.moveTo(state.trail[i - 1].x, state.trail[i - 1].y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    })
    ctx.restore()
  }

  const target = nextGem(state)
  state.gems.forEach((gem) => {
    if (gem.collected) return
    drawGem(ctx, gem, gemRadius, props.gemStyle, gem.id === target?.id ? 1 : 0, time)
  })

  // Big label in the free corner: the letter or the shape emoji.
  const labelSize = Math.round(Math.min(width, height) * (state.path.label.length === 1 && /[A-Z]/.test(state.path.label) ? 0.34 : 0.22))
  ctx.font = `800 ${labelSize}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = celebrating ? props.accent : 'rgba(27,21,51,0.85)'
  ctx.fillText(state.path.label, width * 0.14, height * 0.42)
  if (celebrating) {
    ctx.font = `${Math.round(labelSize * 0.6)}px system-ui, sans-serif`
    ctx.fillText(state.path.emoji, width * 0.14, height * 0.72)
  }

  // Progress bar under the label.
  const barW = width * 0.18
  const barX = width * 0.14 - barW / 2
  const barY = height * 0.9
  ctx.fillStyle = 'rgba(27,21,51,0.15)'
  ctx.beginPath()
  ctx.roundRect(barX, barY, barW, 14, 7)
  ctx.fill()
  ctx.fillStyle = props.accent
  ctx.beginPath()
  ctx.roundRect(barX, barY, Math.max(14, barW * traceProgress(state)), 14, 7)
  ctx.fill()
  drawParticles(ctx, particles)
}

/** Shared canvas stage for the tracing games: gems along a guided path, collected by dragging a finger. */
export const TraceStage = (props: TraceStageProps) => {
  const { stage, paths, config } = props
  const stateRef = useRef<TraceState | null>(null)
  const indexRef = useRef(0)
  const particlesRef = useRef<readonly Particle[]>([])
  const timeRef = useRef(0)
  const [score, setScore] = useState({ gems: 0, done: 0 })
  const gemsRef = useRef(0)

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    timeRef.current += dtSec
    if (!stateRef.current || stateRef.current.box.size !== Math.min(width * 0.62, height * 0.86)) {
      stateRef.current = createTraceState(paths[indexRef.current % paths.length], width, height, config, stateRef.current?.completed ?? 0)
      if (stage.active) say(props.intro(stateRef.current.path))
    }

    if (stage.active) {
      const touches = stage.touchesRef.current.map((t) => ({ x: t.x, y: t.y }))
      const { state, events } = stepTrace(stateRef.current, dtSec, { touches, width, height, config })
      stateRef.current = state
      events.collected.forEach((gem) => {
        playSparkle()
        gemsRef.current += 1
        particlesRef.current = [...particlesRef.current, ...spawnBurst(gem, { count: 14, colors: [GEM_COLORS[gem.id % GEM_COLORS.length], '#ffffff'], speed: [60, 200], size: [3, 7], life: [0.4, 0.8], gravity: 120 })]
      })
      if (events.completed) {
        playCheer()
        playCatch()
        const line = props.outro(state.path)
        if (line) say(line)
        recordEvent({ game: props.gameId, skill: props.skill, detail: state.path.id })
        particlesRef.current = [...particlesRef.current, ...spawnBurst({ x: width * 0.55, y: height * 0.45 }, { count: 90, colors: CONFETTI, speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 })]
        setScore({ gems: gemsRef.current, done: state.completed })
      } else if (events.collected.length > 0) {
        setScore({ gems: gemsRef.current, done: state.completed })
      }
      if (events.hint) speakHint('Put your finger on the sparkly one and follow the path!')
      if (events.advance) {
        indexRef.current += 1
        stateRef.current = createTraceState(paths[indexRef.current % paths.length], width, height, config, state.completed)
        say(props.intro(stateRef.current.path))
      }
    }

    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawScene(ctx, width, height, stateRef.current, props, particlesRef.current, timeRef.current)
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'gems', text: `${props.hudEmoji} ${score.gems}`, accent: true },
        { id: 'done', text: `⭐ ${score.done}` },
      ]}
    />
  )
}
