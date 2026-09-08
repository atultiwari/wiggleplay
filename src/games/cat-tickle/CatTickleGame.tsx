import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import { drawPointerCursor } from '../../components/game/drawPointer'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCheer, playMeow } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { CAT_INFO, catScale, configFromSettings, createCatState, stepCats, type Cat, type CatState } from './logic'

type CatImages = Readonly<Record<'catOrange' | 'catGrey' | 'catBlack', HTMLImageElement>>

const speakCat = createThrottledSpeaker(900)

const drawBackground = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, 'rgba(255, 236, 210, 0.35)')
  gradient.addColorStop(1, 'rgba(255, 200, 150, 0.35)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

const drawCat = (ctx: CanvasRenderingContext2D, cat: Cat, image: HTMLImageElement) => {
  const scale = catScale(cat)
  if (scale <= 0) return
  const size = cat.size * scale
  ctx.save()
  ctx.translate(cat.x, cat.y)
  if (cat.phase === 'happy') ctx.rotate(Math.sin(cat.phaseSec * 18) * 0.12)
  ctx.drawImage(image, -size / 2, -size / 2, size, size)
  ctx.restore()
}

const CatTickleStage = ({ stage }: { readonly stage: GameStage }) => {
  const stateRef = useRef<CatState>(createCatState())
  const settingsRef = useSettingsRef()
  const [images, setImages] = useState<CatImages | null>(null)
  const [tickled, setTickled] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadImageMap({ catOrange: ART.catOrange, catGrey: ART.catGrey, catBlack: ART.catBlack })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[cat-tickle] images failed', error))
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
    const pointers = stage.pointersRef.current

    if (stage.active) {
      const config = configFromSettings(settingsRef.current.catTickle)
      const { state, events } = stepCats(stateRef.current, dtSec, { pointers, width, height, config })
      stateRef.current = state
      if (events.tickled.length > 0) {
        playMeow()
        speakCat(`Meow! ${CAT_INFO[events.tickled[0].kind].name}!`)
        events.tickled.forEach((cat) => recordEvent({ game: 'cat-tickle', skill: 'animals', detail: cat.kind }))
        setTickled(state.tickled)
      }
      if (events.milestone) {
        playCheer()
        say('Purr purr! Happy cats!')
      }
    }

    const state = stateRef.current
    ctx.clearRect(0, 0, width, height)
    drawBackground(ctx, width, height)
    state.cats.forEach((cat) => drawCat(ctx, cat, images[CAT_INFO[cat.kind].art]))
    drawParticles(ctx, state.particles)
    if (settingsRef.current.global.showHandCursor) pointers.forEach((p) => drawPointerCursor(ctx, p, '#ffb703'))
  }, stage.size.width > 0)

  return <Hud badges={[{ id: 'tickled', text: `🐱 ${tickled}`, accent: true }]} />
}

const CatTickleGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>{(stage) => <CatTickleStage stage={stage} />}</GameShell>
)

export default CatTickleGame
