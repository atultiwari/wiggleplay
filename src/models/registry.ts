import type * as THREE from 'three'
import type { CameraSpec } from '../lab/viewer'
import { MASCOT_FILL, NEUTRAL_FILL, type StageLightingOptions } from './stageLighting'

export type ModelFactory = () => THREE.Group

export interface ModelEntry {
  readonly id: string
  readonly title: string
  readonly load: () => Promise<ModelFactory>
  /** Per-model camera overrides for the lab viewer (e.g. the reference-matched framing). */
  readonly views?: Readonly<Record<string, CameraSpec>>
  /** Lighting declared in the model's sculpt spec (lightingFromPhoto). */
  readonly lighting?: StageLightingOptions
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
    views: { match: { azimuth: 0, elevation: 0, distance: 1.64, target: [0, 0.526, 0] } },
    lighting: MASCOT_FILL,
  },
  {
    id: 'cat',
    title: 'WigglePlay cat',
    lighting: { fillSky: '#ffffff', fillGround: '#f3ece4', keyDirection: [-0.35, 0.6, 1.0], keyIntensity: 1.5, toneMapping: 'neutral', exposure: 1.55 },
    load: () => import('./cat/createWigglePlayCatModel').then((m) => () => m.createWigglePlayCatModel()),
    views: {
      match: { azimuth: 0, elevation: 0, distance: 1.465, target: [0.0896, 0.5063, 0] },
      front: { azimuth: 0, elevation: 0, distance: 2.3, target: [0.05, 0.5, 0] },
      hero: { azimuth: -30, elevation: 8, distance: 2.3, target: [0.05, 0.5, 0] },
      right: { azimuth: 90, elevation: 0, distance: 2.3, target: [0.05, 0.5, 0] },
      rear: { azimuth: 180, elevation: 0, distance: 2.3, target: [0.05, 0.5, 0] },
      left: { azimuth: 270, elevation: 0, distance: 2.3, target: [0.05, 0.5, 0] },
      'orbit-plus': { azimuth: 35, elevation: 6, distance: 2.3, target: [0.05, 0.5, 0] },
      'orbit-minus': { azimuth: -35, elevation: 6, distance: 2.3, target: [0.05, 0.5, 0] },
      'rear-quarter': { azimuth: 135, elevation: 6, distance: 2.3, target: [0.05, 0.5, 0] },
      head: { azimuth: 0, elevation: 2, distance: 1.0, target: [0, 0.72, 0] },
      'head-quarter': { azimuth: -30, elevation: 2, distance: 1.0, target: [0, 0.72, 0] },
    },
  },
  {
    id: 'plane',
    title: 'WigglePlay plane',
    lighting: { fillSky: '#ffffff', fillGround: '#eef2fa', keyDirection: [-0.35, 0.6, 1.0], keyIntensity: 1.5, toneMapping: 'neutral', exposure: 1.55 },
    load: () => import('./plane/createWigglePlayPlaneModel').then((m) => () => m.createWigglePlayPlaneModel()),
    views: {
      match: { azimuth: 0, elevation: 0, distance: 1.6, target: [0.049, 0.358, 0] },
      front: { azimuth: 0, elevation: 0, distance: 2.3, target: [0.05, 0.36, 0] },
      hero: { azimuth: -30, elevation: 8, distance: 2.3, target: [0.05, 0.36, 0] },
      right: { azimuth: 90, elevation: 0, distance: 2.3, target: [0.05, 0.36, 0] },
      rear: { azimuth: 180, elevation: 0, distance: 2.3, target: [0.05, 0.36, 0] },
      left: { azimuth: 270, elevation: 0, distance: 2.3, target: [0.05, 0.36, 0] },
      'orbit-plus': { azimuth: 35, elevation: 6, distance: 2.3, target: [0.05, 0.36, 0] },
      'orbit-minus': { azimuth: -35, elevation: 6, distance: 2.3, target: [0.05, 0.36, 0] },
      'rear-quarter': { azimuth: 135, elevation: 6, distance: 2.3, target: [0.05, 0.36, 0] },
      head: { azimuth: 0, elevation: 2, distance: 0.9, target: [-0.3, 0.35, 0] },
      'head-quarter': { azimuth: -30, elevation: 2, distance: 0.9, target: [-0.3, 0.35, 0] },
    },
  },
  {
    id: 'bus',
    title: 'WigglePlay bus',
    lighting: { ...NEUTRAL_FILL, keyDirection: [-0.35, 0.6, 1.0], keyIntensity: 1.5, toneMapping: 'neutral', exposure: 1.35 },
    load: () => import('./bus/createWigglePlayBusModel').then((m) => () => m.createWigglePlayBusModel()),
    views: {
      match: { azimuth: 0, elevation: 0, distance: 1.736, target: [0, 0.27, 0] },
      front: { azimuth: 0, elevation: 0, distance: 2.2, target: [0, 0.3, 0] },
      hero: { azimuth: -30, elevation: 8, distance: 2.2, target: [0, 0.3, 0] },
      right: { azimuth: 90, elevation: 0, distance: 2.2, target: [0, 0.3, 0] },
      rear: { azimuth: 180, elevation: 0, distance: 2.2, target: [0, 0.3, 0] },
      left: { azimuth: 270, elevation: 0, distance: 2.2, target: [0, 0.3, 0] },
      'orbit-plus': { azimuth: 35, elevation: 6, distance: 2.2, target: [0, 0.3, 0] },
      'orbit-minus': { azimuth: -35, elevation: 6, distance: 2.2, target: [0, 0.3, 0] },
      'rear-quarter': { azimuth: 135, elevation: 6, distance: 2.2, target: [0, 0.3, 0] },
      head: { azimuth: 0, elevation: 2, distance: 0.9, target: [0.25, 0.4, 0] },
      'head-quarter': { azimuth: -30, elevation: 2, distance: 0.9, target: [0.25, 0.4, 0] },
    },
  },
]

export const findModel = (id: string | undefined): ModelEntry | undefined => MODELS.find((m) => m.id === id)
