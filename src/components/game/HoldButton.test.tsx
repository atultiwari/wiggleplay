import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { HoldButton } from './HoldButton'

describe('HoldButton', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires only after being held for the full duration', () => {
    const onHold = vi.fn()
    render(<HoldButton label="Hold to exit" icon="🏠" onHold={onHold} holdMs={1000} />)
    const button = screen.getByRole('button', { name: 'Hold to exit' })
    fireEvent.pointerDown(button)
    act(() => vi.advanceTimersByTime(500))
    expect(onHold).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(600))
    expect(onHold).toHaveBeenCalledTimes(1)
  })

  it('cancels when released early', () => {
    const onHold = vi.fn()
    render(<HoldButton label="Hold" icon="⏰" onHold={onHold} holdMs={1000} />)
    const button = screen.getByRole('button', { name: 'Hold' })
    fireEvent.pointerDown(button)
    act(() => vi.advanceTimersByTime(400))
    fireEvent.pointerUp(button)
    act(() => vi.advanceTimersByTime(2000))
    expect(onHold).not.toHaveBeenCalled()
  })
})
