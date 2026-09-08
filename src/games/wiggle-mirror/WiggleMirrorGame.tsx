import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { playCatch, playCheer, playSparkle } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { createWigglePlayMascotModel } from '../../models/mascot/createWigglePlayMascotModel'
import { createStageLighting } from '../../models/stageLighting'
import { detectReactions, IDLE_POSE, INITIAL_REACTIONS, poseFromLandmarks, SKELETON_LINKS, smoothPose, type PuppetPose, type ReactionState } from './logic'
import './WiggleMirrorGame.css'

const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']

interface Puppet {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly root: THREE.Group
  readonly bones: Record<string, THREE.Bone>
  readonly skeleton: THREE.Skeleton | undefined
}

/** Builds the Three.js scene on the shell's canvas: transparent so the camera picture shows through. */
const createPuppet = (canvas: HTMLCanvasElement): Puppet => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  createStageLighting(scene)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50)
  camera.position.set(0, 0.5, 3.2)
  camera.lookAt(0, 0.5, 0)
  const root = createWigglePlayMascotModel({ castShadow: false, receiveShadow: false })
  const rig = root.userData.rig as { bones?: Record<string, THREE.Bone>; skeleton?: THREE.Skeleton } | undefined
  const holder = new THREE.Group()
  holder.add(root)
  scene.add(holder)
  return { renderer, scene, camera, root: holder, bones: rig?.bones ?? {}, skeleton: rig?.skeleton }
}

const applyPose = (puppet: Puppet, pose: PuppetPose, size: number, aspect: number) => {
  // Visible half-height of the world at the puppet's depth, so screen-space pose maps to world units.
  const halfHeight = Math.tan((puppet.camera.fov * Math.PI) / 360) * puppet.camera.position.z
  const halfWidth = halfHeight * aspect
  const scale = size * pose.scale
  puppet.root.scale.setScalar(scale)
  puppet.root.position.set(pose.x * halfWidth * 0.8, 0.5 + (pose.y - 0.5) * halfHeight * 1.2 - 0.5 * scale, 0)
  Object.entries(pose.bones).forEach(([id, [x, y, z]]) => puppet.bones[id]?.rotation.set(x, y, z))
  puppet.root.updateMatrixWorld(true)
  puppet.skeleton?.update()
}

const WiggleMirrorStage = ({ stage }: { readonly stage: GameStage }) => {
  const settingsRef = useSettingsRef()
  const puppetRef = useRef<Puppet | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const poseRef = useRef<PuppetPose>(IDLE_POSE)
  const reactionsRef = useRef<ReactionState>(INITIAL_REACTIONS)
  const particlesRef = useRef<readonly Particle[]>([])
  const [counts, setCounts] = useState({ hoorays: 0, jumps: 0 })
  const failedRef = useRef(false)

  useEffect(
    () => () => {
      puppetRef.current?.renderer.dispose()
      puppetRef.current = null
    },
    [],
  )

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0 || failedRef.current) return
    if (!puppetRef.current) {
      try {
        puppetRef.current = createPuppet(canvas)
      } catch (error) {
        failedRef.current = true
        console.error('[wiggle-mirror] WebGL puppet failed', error)
        return
      }
    }
    const puppet = puppetRef.current
    const { width, height } = stage.size
    if (canvas.width !== Math.round(width * puppet.renderer.getPixelRatio())) {
      puppet.renderer.setSize(width, height, false)
      puppet.camera.aspect = width / height
      puppet.camera.updateProjectionMatrix()
    }
    const settings = settingsRef.current
    const landmarks = stage.poseRef.current

    if (stage.active) {
      const target = poseFromLandmarks(landmarks)
      poseRef.current = smoothPose(poseRef.current, target, 0.35)
      const { state, events } = detectReactions(reactionsRef.current, poseRef.current, dtSec)
      reactionsRef.current = state
      if (settings.wiggleMirror.reactions) {
        if (events.hooray) {
          playCheer()
          say('Hooray!')
          recordEvent({ game: 'wiggle-mirror', skill: 'gross-motor', detail: 'hooray' })
          particlesRef.current = [...particlesRef.current, ...spawnBurst({ x: width / 2, y: height * 0.3 }, { count: 90, colors: CONFETTI, speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 })]
          setCounts({ hoorays: state.hoorays, jumps: state.jumps })
        }
        if (events.jump) {
          playCatch()
          playSparkle()
          say('Boing!')
          recordEvent({ game: 'wiggle-mirror', skill: 'gross-motor', detail: 'jump' })
          setCounts({ hoorays: state.hoorays, jumps: state.jumps })
        }
      }
    }

    applyPose(puppet, poseRef.current, settings.wiggleMirror.puppetSize, width / height)
    puppet.renderer.render(puppet.scene, puppet.camera)

    const overlay = overlayRef.current
    if (!overlay) return
    const ctx = prepareCanvas(overlay, stage.size)
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawParticles(ctx, particlesRef.current)
    if (settings.wiggleMirror.showSkeleton && landmarks) {
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
  }, stage.size.width > 0)

  return (
    <>
      <canvas ref={overlayRef} className="mirror__overlay" aria-hidden="true" />
      <Hud
        badges={[
          { id: 'hooray', text: `🙌 ${counts.hoorays}`, accent: true },
          { id: 'jumps', text: `🦘 ${counts.jumps}` },
        ]}
      />
    </>
  )
}

const WiggleMirrorGame = ({ game }: { readonly game: GameMeta }) => (
  <GameShell game={game}>{(stage) => <WiggleMirrorStage stage={stage} />}</GameShell>
)

export default WiggleMirrorGame
