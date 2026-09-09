import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { ActivityShell, type ActivityStage } from '../../components/game/ActivityShell'
import { Hud } from '../../components/game/Hud'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playBaa, playCheer, playMeow, playMoo, playOink, playQuack, playWoof } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { CALL_INFO, callProgress, configFromSettings, createCallState, currentAnimal, DANCE_SEC, stepCall, type CallAnimal, type CallState } from './logic'

type CallImages = Readonly<Record<CallAnimal, HTMLImageElement>>
const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']
const SOUNDS: Readonly<Record<CallAnimal, () => void>> = { cow: playMoo, sheep: playBaa, duck: playQuack, pig: playOink, cat: playMeow, dog: playWoof }

const drawMeter = (ctx: CanvasRenderingContext2D, width: number, height: number, level: number, threshold: number, progress: number) => {
  const barWidth = Math.min(width * 0.6, 520)
  const barHeight = 34
  const x = (width - barWidth) / 2
  const y = height - barHeight - 28
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.beginPath()
  ctx.roundRect(x, y, barWidth, barHeight, 17)
  ctx.fill()
  const fill = ctx.createLinearGradient(x, 0, x + barWidth, 0)
  fill.addColorStop(0, '#7dd3fc')
  fill.addColorStop(1, '#f97316')
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(barHeight, barWidth * Math.min(1, level)), barHeight, 17)
  ctx.fill()
  ctx.strokeStyle = progress > 0 ? '#16a34a' : '#1b1533'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(x + barWidth * threshold, y - 8)
  ctx.lineTo(x + barWidth * threshold, y + barHeight + 8)
  ctx.stroke()
  ctx.font = '700 22px system-ui, sans-serif'
  ctx.fillStyle = '#1b1533'
  ctx.textAlign = 'center'
  ctx.fillText('🎤 louder →', x + barWidth / 2, y - 14)
  ctx.restore()
}

const CallStage = ({ stage }: { readonly stage: ActivityStage }) => {
  const settingsRef = useSettingsRef()
  const stateRef = useRef<CallState>(createCallState())
  const particlesRef = useRef<readonly Particle[]>([])
  const [images, setImages] = useState<CallImages | null>(null)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ cow: ART.cow, sheep: ART.sheep, duck: ART.duck, pig: ART.pig, cat: ART.catOrange, dog: ART.dog })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[animal-call] images failed', error))
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
    const settings = settingsRef.current.animalCall
    const config = configFromSettings(settings)
    const level = stage.micRef.current.level

    if (stage.active) {
      const { state, events } = stepCall(stateRef.current, dtSec, { level, config })
      stateRef.current = state
      if (events.asked) {
        SOUNDS[events.asked]()
        say(CALL_INFO[events.asked].ask)
      }
      if (events.answered) {
        playCheer()
        SOUNDS[events.answered]()
        say(`${CALL_INFO[events.answered].sound} Wonderful!`)
        recordEvent({ game: 'animal-call', skill: 'speaking', detail: events.answered })
        setTotal(state.total)
        particlesRef.current = [...particlesRef.current, ...spawnBurst({ x: width / 2, y: height * 0.4 }, { count: 80, colors: CONFETTI, speed: [140, 420], size: [5, 11], life: [1, 2], gravity: 260 })]
      }
      if (events.nextAnimal) say(`Here comes the ${CALL_INFO[events.nextAnimal].name}!`)
      if (events.nudge) say(`Louder! ${CALL_INFO[currentAnimal(state)].sound}`)
    }

    const state = stateRef.current
    const animal = currentAnimal(state)
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, '#fff1d6')
    gradient.addColorStop(1, '#ffd9a8')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)

    const base = Math.min(width, height) * 0.55
    const dance = state.phase === 'dancing' ? Math.sin((state.phaseSec / DANCE_SEC) * Math.PI * 6) : 0
    const listenPulse = state.phase === 'listening' ? 1 + Math.min(0.25, level * 0.4) : 1
    const size = base * (1 + Math.abs(dance) * 0.15) * listenPulse
    ctx.save()
    ctx.translate(width / 2, height * 0.46 - Math.abs(dance) * height * 0.08)
    ctx.rotate(dance * 0.25)
    ctx.drawImage(images[animal], -size / 2, -size / 2, size, size)
    ctx.restore()

    ctx.font = `700 ${Math.round(Math.min(width, height) * 0.09)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillStyle = '#1b1533'
    ctx.fillText(state.phase === 'dancing' ? `${CALL_INFO[animal].sound} 🎉` : CALL_INFO[animal].sound, width / 2, height * 0.12)
    if (settings.showMeter) drawMeter(ctx, width, height, level, config.loudness, callProgress(state))
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawParticles(ctx, particlesRef.current)
  }, stage.size.width > 0)

  return <Hud badges={[{ id: 'calls', text: `🎤 ${total}`, accent: true }]} />
}

const AnimalCallGame = ({ game }: { readonly game: GameMeta }) => (
  <ActivityShell game={game} sensor="microphone">
    {(stage) => <CallStage stage={stage} />}
  </ActivityShell>
)

export default AnimalCallGame
