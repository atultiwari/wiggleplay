import { Suspense } from 'react'
import { Link, useParams } from 'react-router-dom'
import { SiteFooter, SiteHeader } from '../components/layout/SiteHeader'
import { findGame } from '../config/games'
import { GAME_COMPONENTS } from '../games/registry'

const Missing = ({ message }: { readonly message: string }) => (
  <div>
    <SiteHeader />
    <main style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>Hmm…</h1>
      <p style={{ margin: '1rem 0' }}>{message}</p>
      <Link to="/" className="btn">
        Back to games
      </Link>
    </main>
    <SiteFooter />
  </div>
)

export const GamePage = () => {
  const { id } = useParams()
  const game = findGame(id)
  if (!game) return <Missing message="We could not find that game." />
  const Component = GAME_COMPONENTS[game.id]
  if (!Component || game.status !== 'ready') return <Missing message="That game is still being built. Check back soon!" />
  return (
    <Suspense fallback={<div className="shell" />}>
      <Component game={game} />
    </Suspense>
  )
}
