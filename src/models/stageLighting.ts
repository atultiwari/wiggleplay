import * as THREE from 'three'

/**
 * The lighting rig recorded in every model's sculpt spec (lightingFromPhoto):
 * key from upper-left-front, hemisphere fill, soft rim. Shared by the lab viewer and the games
 * so a model reviewed in the lab looks the same inside a game.
 */
export const createStageLighting = (scene: THREE.Scene, options: { readonly shadows?: boolean } = {}): void => {
  const key = new THREE.DirectionalLight('#ffffff', 1.4)
  key.position.set(-0.6, 0.9, 0.8).multiplyScalar(4)
  if (options.shadows) {
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = key.shadow.camera.bottom = -1.5
    key.shadow.camera.right = key.shadow.camera.top = 1.5
  }
  scene.add(key)
  scene.add(new THREE.HemisphereLight('#f4f0ff', '#6a4fb8', 1.0))
  const rim = new THREE.DirectionalLight('#e6d6ff', 0.5)
  rim.position.set(0.5, 0.4, -1.0).multiplyScalar(4)
  scene.add(rim)
}
