import {
  advanceHue,
  brushColor,
  CLEAR_ID,
  clearPaint,
  countPoints,
  extendStroke,
  hitSwatch,
  INITIAL_PAINT_STATE,
  liftBrush,
  MAX_POINTS,
  MIN_POINT_DISTANCE,
  PALETTE,
  paletteLayout,
  RAINBOW_ID,
  selectColor,
} from './logic'

describe('air paint logic', () => {
  it('starts a stroke and extends it, skipping tiny moves', () => {
    let state = extendStroke(INITIAL_PAINT_STATE, { x: 0, y: 0 })
    expect(state.current?.points).toHaveLength(1)
    state = extendStroke(state, { x: MIN_POINT_DISTANCE - 1, y: 0 })
    expect(state.current?.points).toHaveLength(1)
    state = extendStroke(state, { x: 20, y: 0 })
    expect(state.current?.points).toHaveLength(2)
    expect(state.current?.color).toBe(brushColor(INITIAL_PAINT_STATE))
  })

  it('lifts the brush into the stroke list and clears', () => {
    const drawn = extendStroke(extendStroke(INITIAL_PAINT_STATE, { x: 0, y: 0 }), { x: 30, y: 0 })
    const lifted = liftBrush(drawn)
    expect(lifted.current).toBeNull()
    expect(lifted.strokes).toHaveLength(1)
    expect(liftBrush(lifted)).toBe(lifted)
    expect(clearPaint(lifted).strokes).toHaveLength(0)
  })

  it('drops the oldest strokes beyond the point budget', () => {
    const bigStroke = { color: '#000', width: 1, points: Array.from({ length: MAX_POINTS }, (_, i) => ({ x: i, y: 0 })) }
    const state = { ...INITIAL_PAINT_STATE, strokes: [bigStroke], current: { ...bigStroke, points: [{ x: 0, y: 0 }] } }
    const lifted = liftBrush(state)
    expect(lifted.strokes).toHaveLength(1)
    expect(countPoints(lifted.strokes)).toBe(1)
  })

  it('selects palette colours and ignores unknown ids', () => {
    const red = selectColor(INITIAL_PAINT_STATE, 'red')
    expect(red.colorId).toBe('red')
    expect(brushColor(red)).toBe(PALETTE[0].hex)
    expect(selectColor(red, 'nope')).toBe(red)
  })

  it('cycles the rainbow hue', () => {
    const rainbow = selectColor(INITIAL_PAINT_STATE, RAINBOW_ID)
    expect(brushColor(rainbow)).toMatch(/^hsl\(/)
    expect(advanceHue(350, 0.1)).toBeLessThan(360)
    expect(advanceHue(0, 0.5)).toBeGreaterThan(0)
  })

  it('lays out swatches across the top with generous hit areas', () => {
    const layout = paletteLayout(1200)
    expect(layout).toHaveLength(PALETTE.length + 1)
    expect(layout[layout.length - 1].id).toBe(CLEAR_ID)
    const first = layout[0]
    expect(hitSwatch(layout, { x: first.x, y: first.y })).toBe(first.id)
    expect(hitSwatch(layout, { x: first.x + first.r * 1.3, y: first.y })).toBe(first.id)
    expect(hitSwatch(layout, { x: 600, y: 900 })).toBeNull()
  })
})
