export interface NamedColor {
  readonly name: string
  readonly hex: string
}

/** Kid-friendly colour names spoken by the games. */
export const NAMED_COLORS: readonly NamedColor[] = [
  { name: 'Red', hex: '#ff4d6d' },
  { name: 'Orange', hex: '#ff9f1c' },
  { name: 'Yellow', hex: '#ffd60a' },
  { name: 'Green', hex: '#3ddc84' },
  { name: 'Blue', hex: '#3a86ff' },
  { name: 'Purple', hex: '#9b5de5' },
  { name: 'Pink', hex: '#ff70b8' },
]
