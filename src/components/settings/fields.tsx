import type { NumberRange } from '../../lib/settings/schema'
import { formatCount } from './format'

interface SliderFieldProps {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly range: NumberRange
  readonly onChange: (value: number) => void
  readonly format?: (value: number) => string
  readonly hint?: string
  readonly disabled?: boolean
}

export const SliderField = ({ id, label, value, range, onChange, format = formatCount, hint, disabled }: SliderFieldProps) => (
  <div className={`field ${disabled ? 'field--disabled' : ''}`}>
    <label className="field__row" htmlFor={id}>
      <span className="field__label">{label}</span>
      <span className="field__value" aria-hidden="true">
        {format(value)}
      </span>
    </label>
    <input
      id={id}
      className="field__slider"
      type="range"
      min={range.min}
      max={range.max}
      step={range.step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    {hint && <p className="field__hint">{hint}</p>}
  </div>
)

interface ToggleFieldProps {
  readonly id: string
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly hint?: string
}

export const ToggleField = ({ id, label, checked, onChange, hint }: ToggleFieldProps) => (
  <div className="field">
    <label className="field__row" htmlFor={id}>
      <span className="field__label">{label}</span>
      <input
        id={id}
        className="field__toggle"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
    {hint && <p className="field__hint">{hint}</p>}
  </div>
)

interface ChoiceOption<T> {
  readonly value: T
  readonly label: string
}

interface ChoiceFieldProps<T extends string | number> {
  readonly label: string
  readonly value: T
  readonly options: readonly ChoiceOption<T>[]
  readonly onChange: (value: T) => void
  readonly hint?: string
}

export const ChoiceField = <T extends string | number>({ label, value, options, onChange, hint }: ChoiceFieldProps<T>) => (
  <fieldset className="field field--choice">
    <legend className="field__label">{label}</legend>
    <div className="field__choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={`chip ${option.value === value ? 'chip--on' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
    {hint && <p className="field__hint">{hint}</p>}
  </fieldset>
)
