import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawPointerCursor } from '../../components/game/drawPointer'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCheer, playHonk, playMeow, playSparkle, playWhoosh } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { bounce, configFromSettings, createBeepState, stepBeep, THING_INFO, type BeepState, type Thing, type ThingArt, type ThingKind } from './logic'

type Images = Readonly<Record<ThingArt, HTMLImageElement>>

const speakThing = createThrottledSpeaker(800)
const SOUNDS: Readonly<Record<ThingKind, () => void>> = { plane: playWhoosh, bus: playHonk, cat: playMeow }

const drawTown = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.7)
  sky.addColorStop(0, 'rgba(140, 200, 255, 0.5)')
  sky.addColorStop(1, 'rgba(235, 245, 255, 0.35)')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height * 0.7)
  ctx.fillStyle = 'rgba(154, 211, 106, 0.55)'
  ctx.fillRect(0, height * 0.7, width, height * 0.3)
  ctx.fillStyle = 'rgba(75, 85, 99, 0.7)'
  ctx.fillRect(0, height * 0.9, width, height * 0.1)
}

const drawThing = (ctx: CanvasRenderingContext2D, thing: Thing, image: HTMLImageElement) => {
  const { lift, scale } = bounce(thing)
  const size = thing.size * scale
  ctx.save()
  ctx.translate(thing.x, thing.y - lift)
  if (thing.vx < 0 && thing.kind !== 'cat') ctx.scale(-1, 1)
  ctx.drawImage(image, -size / 2, -size / 2, size, size)
  ctx.restore()
}

const drawPromptRing = (ctx: CanvasRenderingContext2D, thing: Thing, timeMs: number) => {
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 214, 10, 0.9)'
  ctx.lineWidth = 6
  ctx.setLineDash([14, 10])
  ctx.lineDashOffset = -timeMs / 30
  ctx.beginPath()
  ctx.arc(thing.x, thing.y, thing.size / 2 + 16, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

const BeepMeowStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<BeepState>(createBeepState())
  const settingsRef = useSettingsRef()
  const [images, setImages] = useState<Images | null>(null)
  const [poked, setPoked] = useState(0)
  const [prompt, setPrompt] = useState<ThingKind | null>(null)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ plane: ART.plane, bus: ART.bus, catOrange: ART.catOrange, catGrey: ART.catGrey, catBlack: ART.catBlack })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[beep-meow-whoosh] images failed', error))
    return () => {
      cancelled = true
    }
  }, [])

  useGameLoop((dtSec, nowMs) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0 || !images) return
    const ctx = prepareCanvas(canvas, stage.size)
    if (!ctx) return
    const { width, height } = stage.size
    const pointers = stage.pointersRef.current

    if (stage.active) {
      const config = configFromSettings(settingsRef.current.beepMeow)
      const { state, events } = stepBeep(stateRef.current, dtSec, { pointers, width, height, config })
      stateRef.current = state
      if (events.poked.length > 0) {
        const first = events.poked[0]
        SOUNDS[first.kind]()
        if (!events.found) speakThing(`${THING_INFO[first.kind].sound}! ${THING_INFO[first.kind].name}!`)
        events.poked.forEach((t) => recordEvent({ game: 'beep-meow-whoosh', skill: 'words', detail: t.kind }))
        setPoked(state.poked)
      }
      if (events.found) {
        playSparkle()
        playCheer()
        say(`Yes! You found the ${THING_INFO[events.found].name.toLowerCase()}!`)
        recordEvent({ game: 'beep-meow-whoosh', skill: 'listening', detail: events.found })
      }
      if (events.asked) say(`Where is the ${THING_INFO[events.asked].name.toLowerCase()}?`)
      if (events.asked || events.found || (state.prompt === null && prompt !== null)) setPrompt(state.prompt?.kind ?? null)
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    drawTown(ctx, width, height)
    state.things.forEach((t) => drawThing(ctx, t, images[t.art]))
    if (state.prompt) state.things.filter((t) => t.kind === state.prompt?.kind).forEach((t) => drawPromptRing(ctx, t, nowMs))
    drawParticles(ctx, state.particles)
    if (settingsRef.current.global.showHandCursor) pointers.forEach((p) => drawPointerCursor(ctx, p, '#ffffff'))
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'poked', text: `👆 ${poked}`, accent: true },
        ...(prompt ? [{ id: 'prompt', text: `Find: ${THING_INFO[prompt].emoji}` }] : []),
      ]}
    />
  )
}

const BeepMeowGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>{(stage) => <BeepMeowStage stage={stage} />}</GameShell>
)

export default BeepMeowGame
