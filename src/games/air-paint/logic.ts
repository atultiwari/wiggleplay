import { distance, type Point } from '../../lib/math/vec'

export interface PaintColor {
  readonly id: string
  readonly name: string
  readonly hex: string
}

export const RAINBOW_ID = 'rainbow'
export const CLEAR_ID = 'clear'

export const PALETTE: readonly PaintColor[] = [
  { id: 'red', name: 'Red', hex: '#ff4d4d' },
  { id: 'orange', name: 'Orange', hex: '#ff9f1c' },
  { id: 'yellow', name: 'Yellow', hex: '#ffd60a' },
  { id: 'green', name: 'Green', hex: '#3ddc84' },
  { id: 'blue', name: 'Blue', hex: '#3a86ff' },
  { id: 'purple', name: 'Purple', hex: '#9b5de5' },
  { id: 'pink', name: 'Pink', hex: '#ff70b8' },
  { id: RAINBOW_ID, name: 'Rainbow', hex: 'rainbow' },
]

export interface Stroke {
  readonly color: string
  readonly width: number
  readonly points: readonly Point[]
}

export interface PaintState {
  readonly strokes: readonly Stroke[]
  readonly current: Stroke | null
  readonly colorId: string
  readonly hue: number
}

export const BRUSH_WIDTH = 22
export const MIN_POINT_DISTANCE = 4
/** Oldest strokes are dropped past this many points so drawing stays smooth. */
export const MAX_POINTS = 6000
const HUE_SPEED_DEG_PER_SEC = 140

export const INITIAL_PAINT_STATE: PaintState = {
  strokes: [],
  current: null,
  colorId: 'blue',
  hue: 0,
}

export const rainbowHex = (hue: number): string => `hsl(${Math.round(hue) % 360} 95% 58%)`

export const advanceHue = (hue: number, dtSec: number): number => (hue + HUE_SPEED_DEG_PER_SEC * dtSec) % 360

export const brushColor = (state: PaintState): string => {
  if (state.colorId === RAINBOW_ID) return rainbowHex(state.hue)
  return PALETTE.find((c) => c.id === state.colorId)?.hex ?? PALETTE[0].hex
}

export const countPoints = (strokes: readonly Stroke[]): number =>
  strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)

const trimStrokes = (strokes: readonly Stroke[]): readonly Stroke[] => {
  let result = strokes
  while (result.length > 1 && countPoints(result) > MAX_POINTS) result = result.slice(1)
  return result
}

/** Adds a point to the current stroke, starting one if needed. Ignores tiny movements. */
export const extendStroke = (state: PaintState, p: Point, width: number = BRUSH_WIDTH): PaintState => {
  const color = brushColor(state)
  if (!state.current) {
    return { ...state, current: { color, width, points: [p] } }
  }
  const last = state.current.points[state.current.points.length - 1]
  if (distance(last, p) < MIN_POINT_DISTANCE) return state
  const points = [...state.current.points, p]
  return { ...state, current: { ...state.current, points } }
}

export const liftBrush = (state: PaintState): PaintState => {
  if (!state.current) return state
  const strokes = trimStrokes([...state.strokes, state.current])
  return { ...state, strokes, current: null }
}

export const clearPaint = (state: PaintState): PaintState => ({ ...state, strokes: [], current: null })

export const selectColor = (state: PaintState, colorId: string): PaintState =>
  PALETTE.some((c) => c.id === colorId) ? liftBrush({ ...state, colorId }) : state

export interface Swatch {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly r: number
}

/** Swatches spread across the top of the screen, plus a "clear" sponge at the end. */
export const paletteLayout = (width: number): readonly Swatch[] => {
  const ids = [...PALETTE.map((c) => c.id), CLEAR_ID]
  const r = Math.max(26, Math.min(44, width / (ids.length * 2.6)))
  const gap = r * 2.4
  const totalWidth = gap * (ids.length - 1)
  const startX = width / 2 - totalWidth / 2
  const y = r + 76
  return ids.map((id, i) => ({ id, x: startX + gap * i, y, r }))
}

/** Generous hit test: a fingertip near a swatch counts. */
export const hitSwatch = (layout: readonly Swatch[], p: Point): string | null =>
  layout.find((s) => distance(s, p) <= s.r * 1.35)?.id ?? null
