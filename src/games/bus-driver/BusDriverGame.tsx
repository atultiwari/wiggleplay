import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawPointerCursor } from '../../components/game/drawPointer'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCatch, playCheer, playHonk } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { primaryPointer } from '../../lib/tracking/pointer'
import {
  boardingProgress,
  configFromSettings,
  createBusState,
  PASSENGER_INFO,
  pavementY,
  roadY,
  stepBus,
  type BusConfig,
  type BusState,
  type Passenger,
  type PassengerKind,
} from './logic'

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
type Images = Readonly<Record<PassengerKind | 'bus', HTMLImageElement>>

const drawScene = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const sky = ctx.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, 'rgba(150, 210, 255, 0.45)')
  sky.addColorStop(1, 'rgba(230, 245, 255, 0.35)')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)
  const road = roadY(height)
  const pavement = pavementY(height)
  ctx.fillStyle = '#9ad36a'
  ctx.fillRect(0, pavement - 6, width, 12)
  ctx.fillStyle = '#4b5563'
  ctx.fillRect(0, pavement + 6, width, road - pavement + 24)
  ctx.strokeStyle = '#fde68a'
  ctx.lineWidth = 6
  ctx.setLineDash([40, 30])
  ctx.beginPath()
  ctx.moveTo(0, road - 28)
  ctx.lineTo(width, road - 28)
  ctx.stroke()
  ctx.setLineDash([])
}

const drawPassenger = (ctx: CanvasRenderingContext2D, p: Passenger, busX: number, height: number, image: HTMLImageElement) => {
  const progress = boardingProgress(p)
  const x = p.x + (busX - p.x) * progress
  const size = p.size * (1 - progress * 0.6)
  const y = pavementY(height) - size / 2 - Math.sin(progress * Math.PI) * 60
  ctx.save()
  ctx.globalAlpha = 1 - progress * 0.7
  ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
  ctx.restore()
}

const drawBus = (ctx: CanvasRenderingContext2D, state: BusState, config: BusConfig, height: number, image: HTMLImageElement) => {
  const size = config.busWidth
  const bob = state.departingSec > 0 ? Math.sin(performance.now() / 60) * 3 : 0
  ctx.drawImage(image, state.busX - size / 2, roadY(height) - size * 0.82 + bob, size, size)
}

const BusDriverStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<BusState>(createBusState(stage.size.width))
  const settingsRef = useSettingsRef()
  const [images, setImages] = useState<Images | null>(null)
  const [aboard, setAboard] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ bus: ART.bus, catOrange: ART.catOrange, catGrey: ART.catGrey, catBlack: ART.catBlack, dog: ART.dog, bunny: ART.bunny })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[bus-driver] images failed', error))
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
    const pointer = primaryPointer(stage.pointersRef.current, ['body', 'hand', 'head', 'foot'])
    const config = configFromSettings(settingsRef.current.busDriver)

    if (stage.active) {
      const { state, events } = stepBus(stateRef.current, dtSec, { targetX: pointer ? pointer.palm.x : null, width, height, config })
      stateRef.current = state
      events.boarded.forEach(({ count, kind }) => {
        playCatch()
        say(`${NUMBER_WORDS[count - 1] ?? count}. Hello ${PASSENGER_INFO[kind].name}!`)
        recordEvent({ game: 'bus-driver', skill: 'counting', detail: String(count) })
      })
      if (events.departed) {
        playHonk()
        playCheer()
        say('Ten passengers! All aboard, beep beep!')
      }
      if (events.boarded.length > 0 || events.departed) {
        setAboard(state.aboard)
        setTotal(state.total)
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    drawScene(ctx, width, height)
    state.passengers.forEach((p) => drawPassenger(ctx, p, state.busX, height, images[p.kind]))
    drawBus(ctx, state, config, height, images.bus)
    drawParticles(ctx, state.particles)
    if (pointer && settingsRef.current.global.showHandCursor) drawPointerCursor(ctx, pointer, '#fde047')
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'aboard', text: `🚌 ${aboard} / 10`, accent: true },
        { id: 'total', text: `Total ${total}` },
      ]}
    />
  )
}

const BusDriverGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>{(stage) => <BusDriverStage stage={stage} />}</GameShell>
)

export default BusDriverGame
