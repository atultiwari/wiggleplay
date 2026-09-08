import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { GAMES } from '../config/games'
import { SettingsProvider } from '../lib/settings/SettingsContext'
import { HomePage } from './HomePage'

describe('HomePage', () => {
  it('lists every game and narrows with filters', async () => {
    render(
      <SettingsProvider persist={false}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </SettingsProvider>,
    )
    expect(screen.getAllByTestId(/game-card-/)).toHaveLength(GAMES.length)
    await userEvent.click(screen.getByRole('button', { name: /Tilt & Shake/ }))
    const shown = screen.getAllByTestId(/game-card-/)
    expect(shown.length).toBe(GAMES.filter((g) => g.category === 'motion').length)
    await userEvent.click(screen.getByRole('button', { name: /Animals/ }))
    expect(screen.getByText(/No games match/)).toBeInTheDocument()
  })
})

describe('HomePage settings', () => {
  it('opens the settings drawer from the header', async () => {
    render(
      <SettingsProvider persist={false}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </SettingsProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('dialog', { name: /Settings/ })).toBeInTheDocument()
    expect(screen.getByText('🫧 Wave to Pop')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
