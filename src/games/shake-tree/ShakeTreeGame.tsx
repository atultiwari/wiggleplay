import { useEffect, useRef, useState } from 'react'
import { ART } from '../../assets/art'
import { ActivityShell, type ActivityStage } from '../../components/game/ActivityShell'
import { Hud } from '../../components/game/Hud'
import type { GameMeta } from '../../config/games'
import { loadImageMap } from '../../lib/assets/images'
import { playCheer, playSparkle, playThud } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { configFromSettings, createTreeState, NUMBER_WORDS, stepTree, type TreeState } from './logic'

type TreeImages = Readonly<Record<'tree' | 'apple', HTMLImageElement>>
const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']
const TREE_HALF_WIDTH = 0.3

/** Speed of any finger moving over the tree's canopy, in px/s. */
const dragSpeedOver = (stage: ActivityStage): number => {
  const { width, height } = stage.size
  return stage.touchesRef.current.reduce((best, touch) => {
    const overTree = Math.abs(touch.x - width / 2) < width * TREE_HALF_WIDTH && touch.y < height * 0.75
    return overTree ? Math.max(best, Math.hypot(touch.velocity.x, touch.velocity.y)) : best
  }, 0)
}

const TreeStage = ({ stage }: { readonly stage: ActivityStage }) => {
  const settingsRef = useSettingsRef()
  const stateRef = useRef<TreeState | null>(null)
  const particlesRef = useRef<readonly Particle[]>([])
  const [images, setImages] = useState<TreeImages | null>(null)
  const [score, setScore] = useState({ counted: 0, rounds: 0 })

  useEffect(() => {
    let cancelled = false
    loadImageMap({ tree: ART.tree, apple: ART.apple })
      .then((loaded) => {
        if (!cancelled) setImages(loaded)
      })
      .catch((error: unknown) => console.error('[shake-tree] images failed', error))
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
    const config = configFromSettings(settingsRef.current.shakeTree)
    if (!stateRef.current || (stateRef.current.apples.length !== config.appleCount && stateRef.current.apples.every((a) => a.phase === 'hanging'))) stateRef.current = createTreeState(config)

    if (stage.active) {
      const { state, events } = stepTree(stateRef.current, dtSec, { shake: stage.shakeRef.current.magnitude, dragSpeed: dragSpeedOver(stage), config })
      stateRef.current = state
      if (events.dropped) playSparkle()
      events.landed.forEach((_, i) => {
        playThud()
        const n = state.counted - events.landed.length + i + 1
        say(NUMBER_WORDS[n] ?? String(n))
        recordEvent({ game: 'shake-tree', skill: 'counting', detail: String(n) })
      })
      if (events.finished) {
        playCheer()
        say(`${NUMBER_WORDS[state.counted] ?? state.counted} apples! All the apples fell down. Hooray!`)
        particlesRef.current = [...particlesRef.current, ...spawnBurst({ x: width / 2, y: height * 0.4 }, { count: 90, colors: CONFETTI, speed: [140, 460], size: [5, 11], life: [1.2, 2.4], gravity: 260 })]
      }
      if (events.regrown) say('Look, new apples! Shake the tree again.')
      if (events.landed.length > 0 || events.regrown) setScore({ counted: state.counted, rounds: state.rounds })
    }

    const state = stateRef.current
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, '#bfe3ff')
    sky.addColorStop(0.7, '#eaf7ff')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#9be27a'
    ctx.fillRect(0, height * 0.8, width, height)

    const treeSize = Math.min(width * 0.7, height * 0.82)
    const sway = Math.sin(state.time * 18) * 0.06 * state.wobble
    ctx.save()
    ctx.translate(width / 2, height * 0.82)
    ctx.rotate(sway)
    ctx.drawImage(images.tree, -treeSize / 2, -treeSize, treeSize, treeSize)
    ctx.restore()

    const appleSize = Math.min(width, height) * 0.11
    state.apples.forEach((apple) => {
      const x = apple.u * width + (apple.phase === 'hanging' ? Math.sin(state.time * 18 + apple.id) * 12 * state.wobble : 0)
      const y = apple.v * height
      ctx.save()
      ctx.translate(x, y)
      if (apple.phase === 'falling') ctx.rotate(apple.vy * 2)
      ctx.drawImage(images.apple, -appleSize / 2, -appleSize / 2, appleSize, appleSize)
      ctx.restore()
    })

    if (state.counted > 0) {
      ctx.font = `700 ${Math.round(Math.min(width, height) * 0.16)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = '#1b1533'
      ctx.fillText(String(state.counted), width * 0.85, height * 0.2)
    }
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawParticles(ctx, particlesRef.current)
  }, stage.size.width > 0)

  return (
    <Hud
      badges={[
        { id: 'apples', text: `🍎 ${score.counted}`, accent: true },
        { id: 'rounds', text: `🌳 ${score.rounds}` },
      ]}
    />
  )
}

const ShakeTreeGame = ({ game }: { readonly game: GameMeta }) => (
  <ActivityShell game={game} sensor="motion">
    {(stage) => <TreeStage stage={stage} />}
  </ActivityShell>
)

export default ShakeTreeGame
