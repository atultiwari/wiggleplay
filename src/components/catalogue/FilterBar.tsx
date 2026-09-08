import {
  AGE_BANDS,
  CATEGORIES,
  INTERESTS,
  type AgeBand,
  type GameCategory,
  type GameFilter,
  type Interest,
} from '../../config/games'
import './FilterBar.css'

interface ChipGroupProps<T extends string> {
  readonly label: string
  readonly value: T | 'all'
  readonly options: readonly { id: T; label: string }[]
  readonly onChange: (value: T | 'all') => void
}

const ChipGroup = <T extends string>({ label, value, options, onChange }: ChipGroupProps<T>) => (
  <fieldset className="chips">
    <legend className="chips__legend">{label}</legend>
    <button
      type="button"
      className={`chip ${value === 'all' ? 'chip--on' : ''}`}
      aria-pressed={value === 'all'}
      onClick={() => onChange('all')}
    >
      All
    </button>
    {options.map((option) => (
      <button
        key={option.id}
        type="button"
        className={`chip ${value === option.id ? 'chip--on' : ''}`}
        aria-pressed={value === option.id}
        onClick={() => onChange(option.id)}
      >
        {option.label}
      </button>
    ))}
  </fieldset>
)

export interface FilterBarProps {
  readonly filter: GameFilter
  readonly onChange: (filter: GameFilter) => void
}

const categoryOptions = (Object.keys(CATEGORIES) as GameCategory[]).map((id) => ({
  id,
  label: `${CATEGORIES[id].emoji} ${CATEGORIES[id].label}`,
}))
const interestOptions = (Object.keys(INTERESTS) as Interest[]).map((id) => ({
  id,
  label: `${INTERESTS[id].emoji} ${INTERESTS[id].label}`,
}))

export const FilterBar = ({ filter, onChange }: FilterBarProps) => (
  <div className="filter-bar">
    <ChipGroup<GameCategory>
      label="How to play"
      value={filter.category}
      options={categoryOptions}
      onChange={(category) => onChange({ ...filter, category })}
    />
    <ChipGroup<AgeBand>
      label="Age"
      value={filter.ageBand}
      options={AGE_BANDS}
      onChange={(ageBand) => onChange({ ...filter, ageBand })}
    />
    <ChipGroup<Interest>
      label="Interests"
      value={filter.interest}
      options={interestOptions}
      onChange={(interest) => onChange({ ...filter, interest })}
    />
  </div>
)
