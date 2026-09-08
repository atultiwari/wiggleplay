import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawPointerCursor } from '../../components/game/drawPointer'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCatch, playCheer, playWhoosh } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { primaryPointer } from '../../lib/tracking/pointer'
import { clamp } from '../../lib/math/vec'
import { configFromSettings, createFlyState, planeX, stepFly, type Balloon, type Cloud, type FlyState } from './logic'

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
type Images = Readonly<Record<'plane' | 'cloud', HTMLImageElement>>

const drawSky = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, 'rgba(120, 190, 255, 0.55)')
  gradient.addColorStop(1, 'rgba(210, 240, 255, 0.45)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

const drawCloud = (ctx: CanvasRenderingContext2D, cloud: Cloud, image: HTMLImageElement) => {
  ctx.save()
  ctx.globalAlpha = 0.85
  ctx.drawImage(image, cloud.x - cloud.size / 2, cloud.y - cloud.size / 2, cloud.size, cloud.size)
  ctx.restore()
}

const drawBalloon = (ctx: CanvasRenderingContext2D, balloon: Balloon) => {
  const { x, y, r } = balloon
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(x, y + r)
  ctx.quadraticCurveTo(x + 8, y + r * 1.6, x - 4, y + r * 2.2)
  ctx.stroke()
  const gradient = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r)
  gradient.addColorStop(0, '#ffffffcc')
  gradient.addColorStop(0.3, balloon.color.hex)
  gradient.addColorStop(1, balloon.color.hex)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.ellipse(x, y, r * 0.88, r, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = balloon.color.hex
  ctx.beginPath()
  ctx.moveTo(x - 6, y + r)
  ctx.lineTo(x + 6, y + r)
  ctx.lineTo(x, y + r + 9)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

const drawPlane = (ctx: CanvasRenderingContext2D, state: FlyState, width: number, size: number, image: HTMLImageElement) => {
  ctx.save()
  ctx.translate(planeX(width), state.planeY)
  ctx.rotate(clamp(state.planeVy / 2500, -0.35, 0.35))
  ctx.drawImage(image, -size / 2, -size / 2, size, size)
  ctx.restore()
}

const FlyHighStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<FlyState>(createFlyState(stage.size.height))
  const settingsRef = useSettingsRef()
  const [images, setImages] = useState<Images | null>(null)
  const [count, setCount] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ plane: ART.plane, cloud: ART.cloud })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[fly-high] images failed', error))
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
    const pointer = primaryPointer(stage.pointersRef.current, ['hand', 'head', 'body', 'foot'])
    const config = configFromSettings(settingsRef.current.flyHigh)

    if (stage.active) {
      const { state, events } = stepFly(stateRef.current, dtSec, { targetY: pointer ? pointer.tip.y : null, width, height, config })
      stateRef.current = state
      events.collected.forEach((n) => {
        playCatch()
        say(NUMBER_WORDS[n - 1] ?? String(n))
        recordEvent({ game: 'fly-high', skill: 'counting', detail: String(n) })
      })
      if (events.celebrated) {
        playCheer()
        playWhoosh()
        say('Ten balloons! Whoosh, up we go!')
      }
      if (events.collected.length > 0 || events.celebrated) {
        setCount(state.count)
        setTotal(state.total)
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    drawSky(ctx, width, height)
    state.clouds.forEach((c) => drawCloud(ctx, c, images.cloud))
    state.balloons.forEach((b) => drawBalloon(ctx, b))
    drawPlane(ctx, state, width, config.planeSize, images.plane)
    drawParticles(ctx, state.particles)
    if (pointer && settingsRef.current.global.showHandCursor) drawPointerCursor(ctx, pointer, '#ffffff')
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'count', text: `🎈 ${count} / 10`, accent: true },
        { id: 'total', text: `Total ${total}` },
      ]}
    />
  )
}

const FlyHighGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>{(stage) => <FlyHighStage stage={stage} />}</GameShell>
)

export default FlyHighGame
