import { useState } from 'react'
import { ART } from '../assets/art'
import { FilterBar } from '../components/catalogue/FilterBar'
import { GameCard } from '../components/catalogue/GameCard'
import { SiteFooter, SiteHeader } from '../components/layout/SiteHeader'
import { DEFAULT_FILTER, filterGames, GAMES, type GameFilter } from '../config/games'
import { SITE } from '../config/site'
import './HomePage.css'

export const HomePage = () => {
  const [filter, setFilter] = useState<GameFilter>(DEFAULT_FILTER)
  const games = filterGames(GAMES, filter)
  const readyCount = GAMES.filter((g) => g.status === 'ready').length

  return (
    <div className="home">
      <SiteHeader />
      <main>
        <section className="hero">
          <div className="hero__copy">
            <h1 className="hero__title">
              Turn screen time into <span className="hero__highlight">wiggle time</span>
            </h1>
            <p className="hero__text">{SITE.description}</p>
            <div className="hero__actions">
              <a href="#games" className="btn btn--big">
                ▶ Pick a game
              </a>
              <span className="hero__pill">No keyboard · No mouse · Ages {SITE.minAgeYears}+</span>
            </div>
          </div>
          <img className="hero__mascot" src={ART.mascot} alt="WigglePlay mascot waving" width={320} height={320} />
        </section>

        <section id="games" className="catalogue" aria-labelledby="catalogue-title">
          <div className="catalogue__head">
            <h2 id="catalogue-title">Games</h2>
            <p className="catalogue__count">
              {readyCount} ready to play{GAMES.length > readyCount ? ` · ${GAMES.length - readyCount} coming soon` : ' · more on the way'}
            </p>
          </div>
          <FilterBar filter={filter} onChange={setFilter} />
          {games.length === 0 ? (
            <p className="catalogue__empty">No games match those filters yet. Try another combination!</p>
          ) : (
            <div className="catalogue__grid">
              {games.map((game) => (
                <GameCard key={game.id} game={game} />
              ))}
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
