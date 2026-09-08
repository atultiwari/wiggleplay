import * as THREE from 'three'

/**
 * The lighting rig recorded in every model's sculpt spec (lightingFromPhoto):
 * key from upper-left-front, hemisphere fill, soft rim. Shared by the lab viewer and the games
 * so a model reviewed in the lab looks the same inside a game.
 */
export interface StageLightingOptions {
  readonly shadows?: boolean
  /** Hemisphere fill colours. The mascot spec uses a lavender ground; props use a neutral warm grey. */
  readonly fillSky?: string
  readonly fillGround?: string
  /** Key light direction (from the model toward the light). Default upper-left-front. */
  readonly keyDirection?: readonly [number, number, number]
  readonly keyIntensity?: number
  /** Tone mapping declared in the spec: ACES filmic (mascot) or Neutral (saturated props, keeps hue). */
  readonly toneMapping?: 'aces' | 'neutral'
  readonly exposure?: number
}

/** Applies the spec's tone-mapping intent to a renderer. */
export const applyToneMapping = (renderer: THREE.WebGLRenderer, options: StageLightingOptions = {}): void => {
  renderer.toneMapping = options.toneMapping === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = options.exposure ?? (options.toneMapping === 'neutral' ? 1.0 : 1.25)
}

export const MASCOT_FILL = { fillSky: '#f4f0ff', fillGround: '#6a4fb8' } as const
export const NEUTRAL_FILL = { fillSky: '#ffffff', fillGround: '#e6e0d6' } as const

export const createStageLighting = (scene: THREE.Scene, options: StageLightingOptions = {}): void => {
  const key = new THREE.DirectionalLight('#ffffff', options.keyIntensity ?? 1.4)
  const [kx, ky, kz] = options.keyDirection ?? [-0.6, 0.9, 0.8]
  key.position.set(kx, ky, kz).multiplyScalar(4)
  if (options.shadows) {
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = key.shadow.camera.bottom = -1.5
    key.shadow.camera.right = key.shadow.camera.top = 1.5
  }
  scene.add(key)
  scene.add(new THREE.HemisphereLight(options.fillSky ?? MASCOT_FILL.fillSky, options.fillGround ?? MASCOT_FILL.fillGround, 1.0))
  const rim = new THREE.DirectionalLight('#e6d6ff', 0.5)
  rim.position.set(0.5, 0.4, -1.0).multiplyScalar(4)
  scene.add(rim)
}
