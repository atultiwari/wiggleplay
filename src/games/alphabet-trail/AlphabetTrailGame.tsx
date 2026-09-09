import { useMemo } from 'react'
import { ActivityShell, type ActivityStage } from '../../components/game/ActivityShell'
import type { GameMeta } from '../../config/games'
import { useSettings } from '../../lib/settings/context'
import { LETTERS } from '../../lib/trace/paths'
import { TraceStage } from '../trace/TraceStage'

const letterOrder = (order: 'abc' | 'random'): typeof LETTERS => {
  if (order === 'abc') return LETTERS
  const shuffled = [...LETTERS]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

const AlphabetStage = ({ stage }: { readonly stage: ActivityStage }) => {
  const { settings } = useSettings()
  const v = settings.alphabetTrail
  const paths = useMemo(() => letterOrder(v.order), [v.order])
  const config = useMemo(() => ({ gemSize: v.gemSize }), [v.gemSize])
  return (
    <TraceStage
      stage={stage}
      gameId="alphabet-trail"
      skill="letters"
      paths={paths}
      config={config}
      intro={(path) => `Trace ${path.name}! Collect all the diamonds.`}
      outro={(path) => (v.sayWords ? path.done : `${path.label}! Wonderful!`)}
      gemStyle="diamond"
      accent="#7c5cff"
      background={['#fff1f7', '#ffe0ef']}
      hudEmoji="💎"
    />
  )
}

const AlphabetTrailGame = ({ game }: { readonly game: GameMeta }) => <ActivityShell game={game}>{(stage) => <AlphabetStage stage={stage} />}</ActivityShell>

export default AlphabetTrailGame
