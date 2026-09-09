import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { GameMeta } from '../config/games'

export interface GameComponentProps {
  readonly game: GameMeta
}

type LazyGame = LazyExoticComponent<ComponentType<GameComponentProps>>

/** Each game is code-split so the hub page stays light. */
export const GAME_COMPONENTS: Readonly<Record<string, LazyGame>> = {
  'air-paint': lazy(() => import('./air-paint/AirPaintGame')),
  'catch-stars': lazy(() => import('./catch-stars/CatchStarsGame')),
  'wave-pop': lazy(() => import('./wave-pop/WavePopGame')),
  'fruit-slice': lazy(() => import('./fruit-slice/FruitSliceGame')),
  'cat-tickle': lazy(() => import('./cat-tickle/CatTickleGame')),
  'fly-high': lazy(() => import('./fly-high/FlyHighGame')),
  'bus-driver': lazy(() => import('./bus-driver/BusDriverGame')),
  'beep-meow-whoosh': lazy(() => import('./beep-meow-whoosh/BeepMeowGame')),
  'wiggle-mirror': lazy(() => import('./wiggle-mirror/WiggleMirrorGame')),
  'toy-town': lazy(() => import('./toy-town/ToyTownGame')),
  'simon-says': lazy(() => import('./simon-says/SimonSaysGame')),
  'tap-farm': lazy(() => import('./tap-farm/TapFarmGame')),
  'animal-call': lazy(() => import('./animal-call/AnimalCallGame')),
  'shake-tree': lazy(() => import('./shake-tree/ShakeTreeGame')),
  'alphabet-trail': lazy(() => import('./alphabet-trail/AlphabetTrailGame')),
  'path-tracer': lazy(() => import('./path-tracer/PathTracerGame')),
}
