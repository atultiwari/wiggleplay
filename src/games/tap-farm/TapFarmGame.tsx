import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { ActivityShell, type ActivityStage } from '../../components/game/ActivityShell'
import { Hud } from '../../components/game/Hud'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playBaa, playCheer, playCluck, playMoo, playNeigh, playOink, playQuack } from '../../lib/audio/sfx'
import { createThrottledSpeaker, say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { ANIMAL_INFO, animalBounce, animalCentre, animalSize, configFromSettings, createFarmState, stepFarm, type AnimalKind, type FarmState } from './logic'

type FarmImages = Readonly<Record<AnimalKind | 'barn', HTMLImageElement>>
const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']
const SOUNDS: Readonly<Record<AnimalKind, () => void>> = { cow: playMoo, pig: playOink, sheep: playBaa, chicken: playCluck, duck: playQuack, horse: playNeigh }
const speakAnimal = createThrottledSpeaker(700)

const drawFarm = (ctx: CanvasRenderingContext2D, width: number, height: number, images: FarmImages) => {
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.45)
  sky.addColorStop(0, '#bfe3ff')
  sky.addColorStop(1, '#e9f6ff')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#9be27a'
  ctx.beginPath()
  ctx.ellipse(width / 2, height * 0.62, width * 0.8, height * 0.36, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#8fd66c'
  ctx.fillRect(0, height * 0.62, width, height)
  const barnSize = Math.min(width, height) * 0.26
  ctx.drawImage(images.barn, width * 0.5 - barnSize / 2, height * 0.04, barnSize, barnSize)
}

const FarmStage = ({ stage }: { readonly stage: ActivityStage }) => {
  const settingsRef = useSettingsRef()
  const stateRef = useRef<FarmState | null>(null)
  const particlesRef = useRef<readonly Particle[]>([])
  const [images, setImages] = useState<FarmImages | null>(null)
  const [score, setScore] = useState({ taps: 0, found: 0 })

  useEffect(() => {
    let cancelled = false
    loadImageMap({ cow: ART.cow, pig: ART.pig, sheep: ART.sheep, chicken: ART.chicken, duck: ART.duck, horse: ART.horse, barn: ART.barn })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[tap-farm] images failed', error))
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
    const config = configFromSettings(settingsRef.current.tapFarm)
    if (!stateRef.current || stateRef.current.animals.length !== config.animalCount) stateRef.current = createFarmState(config)
    const taps = stage.takeTaps()

    if (stage.active) {
      const { state, events } = stepFarm(stateRef.current, dtSec, { taps, width, height, config })
      stateRef.current = state
      events.tapped.forEach((kind) => {
        SOUNDS[kind]()
        if (events.promptSolved !== kind) speakAnimal(`${ANIMAL_INFO[kind].name}! ${ANIMAL_INFO[kind].sound}`)
        recordEvent({ game: 'tap-farm', skill: 'animal-names', detail: kind })
        const animal = state.animals.find((a) => a.kind === kind)
        if (animal) particlesRef.current = [...particlesRef.current, ...spawnBurst(animalCentre(animal, width, height), { count: 20, colors: CONFETTI, speed: [80, 220], size: [4, 8], life: [0.5, 1], gravity: 220 })]
      })
      if (events.promptAsked) say(`Where is the ${ANIMAL_INFO[events.promptAsked].name}?`)
      if (events.promptSolved) {
        playCheer()
        say(`Yes! That is the ${ANIMAL_INFO[events.promptSolved].name}. ${ANIMAL_INFO[events.promptSolved].sound}`)
        recordEvent({ game: 'tap-farm', skill: 'listening', detail: events.promptSolved })
      }
      if (events.promptMissed) say(`Here is the ${ANIMAL_INFO[events.promptMissed].name}. Tap it!`)
      if (events.tapped.length > 0 || events.promptSolved) setScore({ taps: state.animals.reduce((sum, a) => sum + a.taps, 0), found: state.found })
    }

    const state = stateRef.current
    drawFarm(ctx, width, height, images)
    const size = animalSize(width, height, config)
    state.animals.forEach((animal) => {
      const centre = animalCentre(animal, width, height)
      const bounce = animalBounce(animal, state.time)
      const drawSize = size * (1 + bounce)
      if (state.prompt === animal.kind) {
        ctx.save()
        ctx.strokeStyle = 'rgba(255, 214, 10, 0.9)'
        ctx.lineWidth = 8
        ctx.setLineDash([16, 12])
        ctx.beginPath()
        ctx.arc(centre.x, centre.y, size * 0.62 * (1 + 0.06 * Math.sin(state.time * 6)), 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      ctx.save()
      ctx.translate(centre.x, centre.y)
      if (animal.happySec > 0) ctx.rotate(Math.sin(state.time * 22) * 0.1)
      ctx.drawImage(images[animal.kind], -drawSize / 2, -drawSize / 2, drawSize, drawSize)
      ctx.restore()
    })
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawParticles(ctx, particlesRef.current)
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'taps', text: `👆 ${score.taps}`, accent: true },
        { id: 'found', text: `⭐ ${score.found}` },
      ]}
    />
  )
}

const TapFarmGame = ({ game }: { readonly game: GameMeta }) => <ActivityShell game={game}>{(stage) => <FarmStage stage={stage} />}</ActivityShell>

export default TapFarmGame
