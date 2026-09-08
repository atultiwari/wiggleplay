import * as THREE from 'three'

/**
 * Deterministic review viewer for img2threejs reconstructions.
 * Exposes the capture contract the skill's tooling expects:
 *   window.__IMG2THREEJS_READY__ = true
 *   window.__IMG2THREEJS_CAPTURE__.setCamera({ azimuth, elevation, distance, target, fov })
 * No orbit controls: every frame is reproducible.
 */
export interface CameraSpec {
  readonly azimuth?: number
  readonly elevation?: number
  readonly distance?: number
  readonly target?: readonly [number, number, number]
  readonly fov?: number
}

export interface ViewerOptions {
  readonly background?: string
  readonly spin?: boolean
  readonly ground?: boolean
  /** Replace every material with an unlit flat colour (map-stripped evidence for review gates). */
  readonly unlit?: boolean
}

export interface ReviewViewer {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly setCamera: (spec: CameraSpec) => void
  readonly setModel: (model: THREE.Object3D) => void
  readonly frame: () => void
  readonly dispose: () => void
}

declare global {
  interface Window {
    __IMG2THREEJS_READY__?: boolean
    __IMG2THREEJS_CAPTURE__?: {
      setCamera: (spec: CameraSpec) => void
      setView: (name: string) => void
      exportMeshes: () => unknown
      exportParts: () => unknown
      pose: (rotations: Record<string, readonly [number, number, number]>) => unknown
      rigInfo: () => unknown
    }
  }
}

export const NAMED_VIEWS: Readonly<Record<string, CameraSpec>> = {
  /** Reference-matched framing: the figure fills ~84% of the frame height like the sticker. */
  match: { azimuth: 0, elevation: 0, distance: 1.64, target: [0, 0.526, 0] },
  front: { azimuth: 0, elevation: 0 },
  hero: { azimuth: 0, elevation: 4 },
  right: { azimuth: 90, elevation: 0 },
  rear: { azimuth: 180, elevation: 0 },
  left: { azimuth: 270, elevation: 0 },
  'orbit-plus': { azimuth: 35, elevation: 6 },
  'orbit-minus': { azimuth: -35, elevation: 6 },
  'rear-quarter': { azimuth: 135, elevation: 6 },
  head: { azimuth: 0, elevation: 2, distance: 0.55, target: [0, 0.72, 0] },
  'head-quarter': { azimuth: 30, elevation: 2, distance: 0.55, target: [0, 0.72, 0] },
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

export const createReviewViewer = (canvas: HTMLCanvasElement, options: ViewerOptions = {}): ReviewViewer => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(options.background ?? '#ffffff')

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100)

  // Lighting per the spec's lightingFromPhoto: key upper-left-front, hemisphere fill, soft rim.
  const key = new THREE.DirectionalLight('#ffffff', 1.4)
  key.position.set(-0.6, 0.9, 0.8).multiplyScalar(4)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = key.shadow.camera.bottom = -1.5
  key.shadow.camera.right = key.shadow.camera.top = 1.5
  scene.add(key)
  scene.add(new THREE.HemisphereLight('#f4f0ff', '#6a4fb8', 1.0))
  const rim = new THREE.DirectionalLight('#e6d6ff', 0.5)
  rim.position.set(0.5, 0.4, -1.0).multiplyScalar(4)
  scene.add(rim)

  if (options.ground !== false) {
    const ground = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48), new THREE.ShadowMaterial({ opacity: 0.35 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0.001
    ground.receiveShadow = true
    scene.add(ground)
  }

  const modelHolder = new THREE.Group()
  scene.add(modelHolder)

  let target = new THREE.Vector3(0, 0.5, 0)
  let distance = 2.6
  let azimuth = 0
  let elevation = 0

  const applyCamera = () => {
    const az = toRadians(azimuth)
    const el = toRadians(elevation)
    camera.position.set(
      target.x + distance * Math.sin(az) * Math.cos(el),
      target.y + distance * Math.sin(el),
      target.z + distance * Math.cos(az) * Math.cos(el),
    )
    camera.up.set(0, 1, 0)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
  }

  const setCamera = (spec: CameraSpec) => {
    if (spec.azimuth !== undefined) azimuth = spec.azimuth
    if (spec.elevation !== undefined) elevation = spec.elevation
    if (spec.distance !== undefined) distance = spec.distance
    if (spec.target) target = new THREE.Vector3(...spec.target)
    if (spec.fov !== undefined) camera.fov = spec.fov
    applyCamera()
    frame()
  }

  const resize = () => {
    const width = canvas.clientWidth || canvas.width
    const height = canvas.clientHeight || canvas.height
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  const frame = () => {
    resize()
    renderer.render(scene, camera)
  }

  const setModel = (model: THREE.Object3D) => {
    modelHolder.clear()
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = false
      if (options.unlit) {
        const source = mesh.material as THREE.MeshPhysicalMaterial
        mesh.material = new THREE.MeshBasicMaterial({
          color: source.color?.clone() ?? new THREE.Color('#888888'),
          vertexColors: source.vertexColors === true,
          transparent: source.transparent,
          opacity: source.opacity,
        })
      }
    })
    modelHolder.add(model)
    applyCamera()
    frame()
  }

  let spinHandle = 0
  if (options.spin) {
    const spin = () => {
      modelHolder.rotation.y += 0.01
      frame()
      spinHandle = requestAnimationFrame(spin)
    }
    spinHandle = requestAnimationFrame(spin)
  }

  const exportMeshes = () => {
    // Matches forge/stage4_review/self_intersection.py: {vertices: [[x,y,z]], indices: [[a,b,c]]}
    const meshes: { name: string; vertices: number[][]; normals: number[][]; indices: number[][] }[] = []
    modelHolder.updateMatrixWorld(true)
    modelHolder.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
      const position = geometry.getAttribute('position')
      const normal = geometry.getAttribute('normal')
      const index = geometry.getIndex()
      const vertices: number[][] = []
      const normals: number[][] = []
      for (let i = 0; i < position.count; i += 1) {
        vertices.push([position.getX(i), position.getY(i), position.getZ(i)])
        normals.push([normal.getX(i), normal.getY(i), normal.getZ(i)])
      }
      const indices: number[][] = []
      if (index) {
        for (let i = 0; i < index.count; i += 3) indices.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)])
      } else {
        for (let i = 0; i < position.count; i += 3) indices.push([i, i + 1, i + 2])
      }
      meshes.push({ name: mesh.name || object.uuid, vertices, normals, indices })
    })
    return { meshes }
  }

  const exportParts = () => {
    // Matches forge/stage4_review/check_part_coverage.py's manifest shape.
    const parts: { name: string; kind: string; module: string; triangles: number }[] = []
    let unnamedMeshes = 0
    modelHolder.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const component = (mesh.userData.sculptComponent as { id?: string; parent?: string } | undefined)?.id
      const index = mesh.geometry.getIndex()
      const triangles = Math.floor((index ? index.count : mesh.geometry.getAttribute('position').count) / 3)
      if (!component) {
        unnamedMeshes += 1
        return
      }
      parts.push({ name: component, kind: 'part', module: (mesh.userData.sculptComponent as { parent?: string }).parent ?? 'root', triangles })
    })
    return { model: modelHolder.children[0]?.name ?? 'model', parts, unnamedMeshes, integralMeshes: parts.length }
  }

  const rigOf = () => {
    const model = modelHolder.children[0]
    return (model?.userData.rig as { bones?: Record<string, THREE.Bone>; skeleton?: THREE.Skeleton; bound?: boolean; boneOrder?: string[] } | undefined) ?? null
  }

  /** Rotates named bones (radians) and re-renders; returns which bones were found. */
  const pose = (rotations: Record<string, readonly [number, number, number]>) => {
    const rig = rigOf()
    if (!rig?.bones) return { applied: [], missing: Object.keys(rotations), bound: false }
    const applied: string[] = []
    const missing: string[] = []
    Object.entries(rotations).forEach(([id, [x, y, z]]) => {
      const bone = rig.bones?.[id]
      if (!bone) {
        missing.push(id)
        return
      }
      bone.rotation.set(x, y, z)
      applied.push(id)
    })
    modelHolder.updateMatrixWorld(true)
    rig.skeleton?.update()
    frame()
    return { applied, missing, bound: rig.bound === true }
  }

  const rigInfo = () => {
    const rig = rigOf()
    return rig ? { bound: rig.bound === true, boneOrder: rig.boneOrder ?? [] } : null
  }

  window.__IMG2THREEJS_CAPTURE__ = {
    setCamera,
    setView: (name) => setCamera(NAMED_VIEWS[name] ?? NAMED_VIEWS.front),
    exportMeshes,
    exportParts,
    pose,
    rigInfo,
  }

  applyCamera()
  frame()
  window.__IMG2THREEJS_READY__ = true

  return {
    scene,
    camera,
    renderer,
    setCamera,
    setModel,
    frame,
    dispose: () => {
      cancelAnimationFrame(spinHandle)
      renderer.dispose()
      window.__IMG2THREEJS_READY__ = false
    },
  }
}
