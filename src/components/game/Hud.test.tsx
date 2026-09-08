import { render, screen } from '@testing-library/react'
import { Hud } from './Hud'

describe('Hud', () => {
  it('renders every badge', () => {
    render(<Hud badges={[{ id: 'a', text: '⭐ 3', accent: true }, { id: 'b', text: 'Total 9' }]} />)
    expect(screen.getByText('⭐ 3')).toHaveClass('hud__badge--accent')
    expect(screen.getByText('Total 9')).toBeInTheDocument()
  })
})
