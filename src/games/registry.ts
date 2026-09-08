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
}
