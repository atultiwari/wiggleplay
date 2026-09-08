import { Link } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { CATEGORIES, type GameMeta } from '../../config/games'
import './GameCard.css'

export const GameCard = ({ game }: { readonly game: GameMeta }) => {
  const ready = game.status === 'ready'
  const body = (
    <>
      <div className="game-card__art" aria-hidden="true">
        <span className="game-card__emoji">{game.emoji}</span>
      </div>
      <div className="game-card__body">
        <h3 className="game-card__title">{game.title}</h3>
        <p className="game-card__blurb">{game.blurb}</p>
        <ul className="game-card__skills" aria-label="Skills">
          {game.skills.map((skill) => (
            <li key={skill}>{skill}</li>
          ))}
        </ul>
        <div className="game-card__meta">
          <span>
            {CATEGORIES[game.category].emoji} {CATEGORIES[game.category].label}
          </span>
          <span>{game.ageBands[0].replace('-', '–')} yrs+</span>
        </div>
      </div>
      {ready ? (
        <span className="game-card__cta">▶ Play</span>
      ) : (
        <span className="game-card__cta game-card__cta--soon">Coming soon</span>
      )}
    </>
  )
  const style = { '--card-accent': game.accent } as CSSProperties
  return ready ? (
    <Link to={`/play/${game.id}`} className="game-card" style={style} data-testid={`game-card-${game.id}`}>
      {body}
    </Link>
  ) : (
    <article className="game-card game-card--soon" style={style} data-testid={`game-card-${game.id}`}>
      {body}
    </article>
  )
}
