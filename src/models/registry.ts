import type * as THREE from 'three'

export type ModelFactory = () => THREE.Group

export interface ModelEntry {
  readonly id: string
  readonly title: string
  readonly load: () => Promise<ModelFactory>
}

/**
 * Procedural Three.js models rebuilt from the sticker art with img2threejs.
 * Each factory is generated code plus hand refinement; no mesh files.
 */
export const MODELS: readonly ModelEntry[] = [
  {
    id: 'mascot',
    title: 'WigglePlay mascot',
    load: () => import('./mascot/createWigglePlayMascotModel').then((m) => () => m.createWigglePlayMascotModel()),
  },
]

export const findModel = (id: string | undefined): ModelEntry | undefined => MODELS.find((m) => m.id === id)
