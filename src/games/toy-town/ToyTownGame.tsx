import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GameShell } from '../../components/game/GameShell'
import { Hud } from '../../components/game/Hud'
import type { GameStage } from '../../components/game/types'
import type { GameMeta } from '../../config/games'
import { playCheer, playHonk, playMeow, playWhoosh } from '../../lib/audio/sfx'
import { say } from '../../lib/audio/voice'
import { prepareCanvas } from '../../lib/game/canvas'
import { drawParticles, spawnBurst, stepParticles, type Particle } from '../../lib/game/particles'
import { useGameLoop } from '../../lib/game/useGameLoop'
import { useSettingsRef } from '../../lib/settings/context'
import { recordEvent } from '../../lib/storage/progress'
import { primaryPointer } from '../../lib/tracking/pointer'
import { createWigglePlayBusModel } from '../../models/bus/createWigglePlayBusModel'
import { createWigglePlayCatModel } from '../../models/cat/createWigglePlayCatModel'
import { createWigglePlayPlaneModel } from '../../models/plane/createWigglePlayPlaneModel'
import { applyToneMapping, createStageLighting } from '../../models/stageLighting'
import { catHeadYaw, configFromSettings, createTownState, planeAltitude, planeBank, PROP_KINDS, PROP_VOICE, REACT_SEC, stepTown, type PropKind, type ScreenSpot, type TownState } from './logic'
import './ToyTownGame.css'

const CONFETTI = ['#ff4d4d', '#ffd60a', '#3ddc84', '#3a86ff', '#ff70b8', '#ffffff']
const TOWN_LIGHTING = { fillSky: '#ffffff', fillGround: '#eef2fa', keyDirection: [-0.35, 0.6, 1.0] as const, keyIntensity: 1.5, toneMapping: 'neutral' as const, exposure: 1.5 }
const BUS_WHEELS = ['wheel-rear-near', 'wheel-front-near', 'wheel-rear-far', 'wheel-front-far']
/** Where each prop lives in the town (world units; props are about one unit long). */
const HOMES: Readonly<Record<PropKind, { readonly z: number; readonly centre: [number, number, number]; readonly halfWidth: number }>> = {
  bus: { z: 0.2, centre: [0, 0.3, 0], halfWidth: 0.55 },
  plane: { z: -1.2, centre: [0, 0.35, 0], halfWidth: 0.6 },
  cat: { z: 1.4, centre: [0, 0.5, 0], halfWidth: 0.45 },
}
const CAT_X = -2.0
const WHEEL_RADIUS = 0.088

type Nodes = Record<string, THREE.Object3D>

interface Town {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly groups: Readonly<Record<PropKind, THREE.Group>>
  readonly nodes: Readonly<Record<PropKind, Nodes>>
}

const runtimeNodes = (root: THREE.Object3D): Nodes => (root.userData.sculptRuntime as { nodes?: Nodes } | undefined)?.nodes ?? {}

const addGround = (scene: THREE.Scene) => {
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), new THREE.MeshStandardMaterial({ color: '#9be27a', roughness: 1 }))
  grass.rotation.x = -Math.PI / 2
  grass.position.set(0, -0.005, 0.6)
  scene.add(grass)
  const road = new THREE.Mesh(new THREE.PlaneGeometry(16, 1.3), new THREE.MeshStandardMaterial({ color: '#5b6470', roughness: 1 }))
  road.rotation.x = -Math.PI / 2
  road.position.set(0, 0, HOMES.bus.z)
  scene.add(road)
  const dashMaterial = new THREE.MeshStandardMaterial({ color: '#ffd60a', roughness: 1 })
  for (let x = -7; x <= 7; x += 1) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.08), dashMaterial)
    dash.rotation.x = -Math.PI / 2
    dash.position.set(x, 0.004, HOMES.bus.z)
    scene.add(dash)
  }
}

/** Builds the Three.js town on the shell's canvas: transparent so the room shows through as the sky. */
const createTown = (canvas: HTMLCanvasElement): Town => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  applyToneMapping(renderer, TOWN_LIGHTING)
  const scene = new THREE.Scene()
  createStageLighting(scene, TOWN_LIGHTING)
  addGround(scene)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50)
  camera.position.set(0, 1.6, 5.2)
  camera.lookAt(0, 0.7, 0)
  const options = { castShadow: false, receiveShadow: false }
  const roots: Record<PropKind, THREE.Group> = {
    bus: createWigglePlayBusModel(options),
    plane: createWigglePlayPlaneModel(options),
    cat: createWigglePlayCatModel(options),
  }
  const groups = { bus: new THREE.Group(), plane: new THREE.Group(), cat: new THREE.Group() } as const
  PROP_KINDS.forEach((kind) => {
    groups[kind].add(roots[kind])
    scene.add(groups[kind])
  })
  const nodes = { bus: runtimeNodes(roots.bus), plane: runtimeNodes(roots.plane), cat: runtimeNodes(roots.cat) } as const
  return { renderer, scene, camera, groups, nodes }
}

const toScreen = (town: Town, point: THREE.Vector3, width: number, height: number) => {
  const v = point.clone().project(town.camera)
  return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height }
}

/** Projects every prop's centre and half-width to canvas pixels for the pure hit-testing logic. */
const screenSpots = (town: Town, size: number, width: number, height: number): Record<PropKind, ScreenSpot> => {
  const spot = (kind: PropKind): ScreenSpot => {
    const home = HOMES[kind]
    const centre = town.groups[kind].position.clone().add(new THREE.Vector3(...home.centre).multiplyScalar(size))
    const c = toScreen(town, centre, width, height)
    const edge = toScreen(town, centre.clone().add(new THREE.Vector3(home.halfWidth * size, 0, 0)), width, height)
    return { x: c.x, y: c.y, r: Math.max(24, Math.hypot(edge.x - c.x, edge.y - c.y)) }
  }
  return { bus: spot('bus'), plane: spot('plane'), cat: spot('cat') }
}

const envelope = (reactingSec: number): number => (reactingSec > 0 ? Math.sin((Math.PI * reactingSec) / REACT_SEC) : 0)

/** Moves the props and plays their idle and reaction animations from the pure state. */
const applyTown = (town: Town, state: TownState, size: number, headYaw: number, dtSec: number) => {
  const { bus, plane, cat } = town.groups
  bus.scale.setScalar(size)
  bus.position.set(state.busX, 0.05 * envelope(state.reacting.bus), HOMES.bus.z)
  bus.rotation.y = state.busDir > 0 ? 0 : Math.PI
  const spin = (0.55 * dtSec) / WHEEL_RADIUS
  BUS_WHEELS.forEach((id) => {
    const wheel = town.nodes.bus[id]
    if (wheel) wheel.rotation.z -= spin
  })
  const door = town.nodes.bus.door
  if (door) door.rotation.y = -1.0 * envelope(state.reacting.bus)

  plane.scale.set(size, size, state.planeDir < 0 ? size : -size)
  plane.position.set(state.planeX, planeAltitude(state.time) * size, HOMES.plane.z)
  plane.rotation.set(0, state.planeDir < 0 ? 0 : Math.PI, planeBank(state.planeDir, state.reacting.plane, state.time))

  cat.scale.setScalar(size)
  cat.position.set(CAT_X, 0, HOMES.cat.z)
  const reacting = envelope(state.reacting.cat)
  const head = town.nodes.cat.head
  if (head) head.rotation.set(-0.18 * reacting, headYaw, 0)
  const tail = town.nodes.cat.tail
  if (tail) tail.rotation.z = Math.sin(state.time * 2.2) * 0.12 + Math.sin(state.time * 16) * 0.5 * reacting
  const earL = town.nodes.cat['ear-l']
  const earR = town.nodes.cat['ear-r']
  if (earL) earL.rotation.z = -0.35 * reacting
  if (earR) earR.rotation.z = 0.35 * reacting
}

const drawOverlay = (ctx: CanvasRenderingContext2D, width: number, height: number, pointer: { x: number; y: number } | null, spots: Record<PropKind, ScreenSpot>, state: TownState, particles: readonly Particle[], showCursor: boolean) => {
  ctx.clearRect(0, 0, width, height)
  if (state.prompt) {
    const spot = spots[state.prompt]
    const pulse = 1 + 0.08 * Math.sin(state.time * 6)
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 214, 10, 0.85)'
    ctx.lineWidth = 8
    ctx.setLineDash([18, 14])
    ctx.beginPath()
    ctx.arc(spot.x, spot.y, spot.r * 1.15 * pulse, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  if (pointer && showCursor) {
    const glow = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 46)
    glow.addColorStop(0, 'rgba(255,255,255,0.85)')
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(pointer.x, pointer.y, 46, 0, Math.PI * 2)
    ctx.fill()
  }
  drawParticles(ctx, particles)
}

const TOUCH_SOUND: Readonly<Record<PropKind, () => void>> = { bus: playHonk, plane: playWhoosh, cat: playMeow }

const ToyTownStage = ({ stage }: { readonly stage: GameStage }) => {
  const settingsRef = useSettingsRef()
  const townRef = useRef<Town | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<TownState>(createTownState())
  const particlesRef = useRef<readonly Particle[]>([])
  const failedRef = useRef(false)
  const [counts, setCounts] = useState(() => createTownState().counts)

  useEffect(
    () => () => {
      townRef.current?.renderer.dispose()
      townRef.current = null
    },
    [],
  )

  useGameLoop((dtSec) => {
    const canvas = stage.canvasRef.current
    if (!canvas || stage.size.width === 0 || failedRef.current) return
    if (!townRef.current) {
      try {
        townRef.current = createTown(canvas)
      } catch (error) {
        failedRef.current = true
        console.error('[toy-town] WebGL town failed', error)
        return
      }
    }
    const town = townRef.current
    const { width, height } = stage.size
    if (canvas.width !== Math.round(width * town.renderer.getPixelRatio())) {
      town.renderer.setSize(width, height, false)
      town.camera.aspect = width / height
      town.camera.updateProjectionMatrix()
    }
    const settings = settingsRef.current.toyTown
    const size = settings.propSize
    const pointer = stage.active ? (primaryPointer(stage.pointersRef.current ?? [], ['hand', 'body', 'head', 'foot'])?.tip ?? null) : null
    const spots = screenSpots(town, size, width, height)

    if (stage.active) {
      const { state, events } = stepTown(stateRef.current, dtSec, { pointer, spots, config: configFromSettings(settings) })
      stateRef.current = state
      events.touched.forEach((kind) => {
        TOUCH_SOUND[kind]()
        if (events.promptSolved !== kind) say(PROP_VOICE[kind].touch)
        recordEvent({ game: 'toy-town', skill: 'vocabulary', detail: kind })
        particlesRef.current = [...particlesRef.current, ...spawnBurst(spots[kind], { count: 26, colors: CONFETTI, speed: [90, 260], size: [4, 9], life: [0.6, 1.2], gravity: 200 })]
      })
      if (events.promptAsked) say(PROP_VOICE[events.promptAsked].ask)
      if (events.promptSolved) {
        playCheer()
        say(PROP_VOICE[events.promptSolved].found)
        recordEvent({ game: 'toy-town', skill: 'listening', detail: events.promptSolved })
        particlesRef.current = [...particlesRef.current, ...spawnBurst(spots[events.promptSolved], { count: 90, colors: CONFETTI, speed: [150, 480], size: [5, 11], life: [1.2, 2.4], gravity: 260 })]
      }
      if (events.promptMissed) say(PROP_VOICE[events.promptMissed].hint)
      if (events.touched.length > 0) setCounts(state.counts)
    }

    applyTown(town, stateRef.current, size, catHeadYaw(pointer, spots.cat), stage.active ? dtSec : 0)
    town.renderer.render(town.scene, town.camera)

    const overlay = overlayRef.current
    if (!overlay) return
    const ctx = prepareCanvas(overlay, stage.size)
    if (!ctx) return
    particlesRef.current = stepParticles(particlesRef.current, dtSec)
    drawOverlay(ctx, width, height, pointer, spots, stateRef.current, particlesRef.current, settings.showCursor)
  }, stage.size.width > 0)

  return (
    <>
      <canvas ref={overlayRef} className="town__overlay" aria-hidden="true" />
      <Hud
        badges={[
          { id: 'bus', text: `🚌 ${counts.bus}`, accent: true },
          { id: 'plane', text: `✈️ ${counts.plane}` },
          { id: 'cat', text: `🐱 ${counts.cat}` },
        ]}
      />
    </>
  )
}

const ToyTownGame = ({ game }: { readonly game: GameMeta }) => <GameShell game={game}>{(stage) => <ToyTownStage stage={stage} />}</GameShell>

export default ToyTownGame
