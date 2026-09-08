import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSettings } from '../../lib/settings/context'
import { SettingsProvider } from '../../lib/settings/SettingsContext'
import { SettingsPanel } from './SettingsPanel'

const Probe = () => {
  const { settings } = useSettings()
  return (
    <output data-testid="probe">
      {settings.global.effectsVolume}|{settings.fruitSlice.tolerance}|{settings.wavePop.maxBubbles}|{String(settings.global.handsTracked)}
    </output>
  )
}

const renderPanel = (gameId?: string, onClose = vi.fn()) => {
  render(
    <SettingsProvider persist={false}>
      <SettingsPanel gameId={gameId} onClose={onClose} />
      <Probe />
    </SettingsProvider>,
  )
  return onClose
}

describe('SettingsPanel', () => {
  it('shows only the current game section inside a game', () => {
    renderPanel('fruit-slice')
    expect(screen.getByRole('region', { name: '🎮 This game' })).toBeInTheDocument()
    expect(screen.queryByText('🫧 Wave to Pop')).toBeNull()
  })

  it('changes the interaction mode', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: '☝️ Point a finger' }))
    expect(screen.getByRole('button', { name: '☝️ Point a finger' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Precise fingertip control/)).toBeInTheDocument()
  })

  it('shows every game section on the hub', () => {
    renderPanel()
    expect(screen.getByText('🐱 Tickle the Cat')).toBeInTheDocument()
    expect(screen.getByText('🚌 Bus Driver')).toBeInTheDocument()
    expect(screen.getByText('🫧 Wave to Pop')).toBeInTheDocument()
    expect(screen.getByText('🍉 Fruit Slice')).toBeInTheDocument()
    expect(screen.getByText('⭐ Catch the Stars')).toBeInTheDocument()
    expect(screen.getByText('🖌️ Air Painting')).toBeInTheDocument()
  })

  it('changes volume, tolerance, counts and hands', async () => {
    renderPanel('fruit-slice')
    fireEvent.change(screen.getByLabelText(/^Sound effects/), { target: { value: '3' } })
    await userEvent.click(screen.getByRole('button', { name: 'Near miss is OK' }))
    await userEvent.click(screen.getByRole('button', { name: 'One (faster)' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('3|generous|7|1')
  })

  it('resets a game section and everything', async () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText(/^Bubbles on screen/), { target: { value: '15' } })
    expect(screen.getByTestId('probe')).toHaveTextContent('|15|')
    const wavePop = screen.getByRole('region', { name: '🫧 Wave to Pop' })
    await userEvent.click(wavePop.querySelector('button.settings__reset') as HTMLButtonElement)
    expect(screen.getByTestId('probe')).toHaveTextContent('|7|')
    fireEvent.change(screen.getByLabelText(/^Sound effects/), { target: { value: '0' } })
    await userEvent.click(screen.getByRole('button', { name: 'Reset everything to defaults' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('2|normal|7|auto')
  })

  it('closes with the button, the backdrop and Escape', async () => {
    const onClose = renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    await userEvent.click(screen.getByTestId('settings-backdrop'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
