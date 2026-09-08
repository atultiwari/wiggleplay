import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GAMES } from '../../config/games'
import { GameCard } from './GameCard'

const ready = GAMES.find((g) => g.status === 'ready')!
const soon = GAMES.find((g) => g.status === 'soon')!

describe('GameCard', () => {
  it('links to the play route for ready games', () => {
    render(
      <MemoryRouter>
        <GameCard game={ready} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', `/play/${ready.id}`)
    expect(screen.getByText(ready.title)).toBeInTheDocument()
    ready.skills.forEach((skill) => expect(screen.getByText(skill)).toBeInTheDocument())
  })

  it('shows coming soon without a link otherwise', () => {
    render(
      <MemoryRouter>
        <GameCard game={soon} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })
})
