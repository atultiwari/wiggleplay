import { useMemo } from 'react'
import { ActivityShell, type ActivityStage } from '../../components/game/ActivityShell'
import type { GameMeta } from '../../config/games'
import { useSettings } from '../../lib/settings/context'
import { EASY_SHAPES, HARDER_SHAPES } from '../../lib/trace/paths'
import { TraceStage } from '../trace/TraceStage'

const PathStage = ({ stage }: { readonly stage: ActivityStage }) => {
  const { settings } = useSettings()
  const v = settings.pathTracer
  const paths = useMemo(() => (v.harderShapes ? [...EASY_SHAPES, ...HARDER_SHAPES] : EASY_SHAPES), [v.harderShapes])
  const config = useMemo(() => ({ gemSize: v.gemSize }), [v.gemSize])
  return (
    <TraceStage
      stage={stage}
      gameId="path-tracer"
      skill="pre-writing"
      paths={paths}
      config={config}
      intro={(path) => `Follow the path and catch the balls. Let's draw a ${path.name}!`}
      outro={(path) => path.done}
      gemStyle="ball"
      accent="#16a34a"
      background={['#e6f7ff', '#d8f5e0']}
      hudEmoji="🟢"
    />
  )
}

const PathTracerGame = ({ game }: { readonly game: GameMeta }) => <ActivityShell game={game}>{(stage) => <PathStage stage={stage} />}</ActivityShell>

export default PathTracerGame
