import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_FILTER } from '../../config/games'
import { FilterBar } from './FilterBar'

describe('FilterBar', () => {
  it('reports category, age and interest changes immutably', async () => {
    const onChange = vi.fn()
    render(<FilterBar filter={DEFAULT_FILTER} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /Camera & Body/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTER, category: 'camera' })
    await userEvent.click(screen.getByRole('button', { name: '2½ – 3 yrs' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTER, ageBand: '2-3' })
    await userEvent.click(screen.getByRole('button', { name: /Fruits/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTER, interest: 'fruits' })
    expect(DEFAULT_FILTER).toEqual({ category: 'all', ageBand: 'all', interest: 'all' })
  })

  it('marks the active chip as pressed', () => {
    render(<FilterBar filter={{ ...DEFAULT_FILTER, category: 'voice' }} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Voice & Sound/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
