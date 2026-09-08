import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { GAMES } from '../config/games'
import { HomePage } from './HomePage'

describe('HomePage', () => {
  it('lists every game and narrows with filters', async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    )
    expect(screen.getAllByTestId(/game-card-/)).toHaveLength(GAMES.length)
    await userEvent.click(screen.getByRole('button', { name: /Tilt & Shake/ }))
    const shown = screen.getAllByTestId(/game-card-/)
    expect(shown.length).toBe(GAMES.filter((g) => g.category === 'motion').length)
    await userEvent.click(screen.getByRole('button', { name: /Animals/ }))
    expect(screen.getByText(/No games match/)).toBeInTheDocument()
  })
})
