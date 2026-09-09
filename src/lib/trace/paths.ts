import type { Point } from '../math/vec'

/**
 * Traceable paths live in a 100 x 100 box (y grows downward). Each path is a list of strokes,
 * each stroke an ordered polyline; the child follows them stroke by stroke.
 */
export type Stroke = readonly Point[]

export interface TracePath {
  readonly id: string
  /** What the voice calls it. */
  readonly name: string
  /** Big label shown in the corner (a letter or an emoji). */
  readonly label: string
  readonly strokes: readonly Stroke[]
  /** Spoken when finished, e.g. "A is for apple". */
  readonly done: string
  readonly emoji: string
}

const P = (x: number, y: number): Point => ({ x, y })

/** Polyline approximating an arc of a circle; angles in degrees, clockwise on screen. */
export const arc = (cx: number, cy: number, r: number, fromDeg: number, toDeg: number, steps = 12): Stroke =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180
    return P(cx + r * Math.cos(a), cy + r * Math.sin(a))
  })

const line = (...pts: readonly (readonly [number, number])[]): Stroke => pts.map(([x, y]) => P(x, y))

const letter = (label: string, word: string, emoji: string, strokes: readonly Stroke[]): TracePath => ({
  id: `letter-${label.toLowerCase()}`,
  name: `the letter ${label}`,
  label,
  strokes,
  done: `${label}! ${label} is for ${word}.`,
  emoji,
})

/** Uppercase alphabet, each drawn the way a child would print it. */
export const LETTERS: readonly TracePath[] = [
  letter('A', 'apple', '🍎', [line([50, 10], [15, 90]), line([50, 10], [85, 90]), line([28, 60], [72, 60])]),
  letter('B', 'bus', '🚌', [line([20, 10], [20, 90]), [...line([20, 10], [55, 10]), ...arc(55, 30, 20, -90, 90), ...line([55, 50], [20, 50])], [...line([20, 50], [58, 50]), ...arc(58, 70, 20, -90, 90), ...line([58, 90], [20, 90])]]),
  letter('C', 'cat', '🐱', [arc(52, 50, 38, -50, 230, 20)]),
  letter('D', 'dog', '🐶', [line([20, 10], [20, 90]), [...line([20, 10], [48, 10]), ...arc(48, 50, 40, -90, 90, 18), ...line([48, 90], [20, 90])]]),
  letter('E', 'egg', '🥚', [line([25, 10], [25, 90]), line([25, 10], [78, 10]), line([25, 50], [68, 50]), line([25, 90], [78, 90])]),
  letter('F', 'fish', '🐟', [line([25, 10], [25, 90]), line([25, 10], [78, 10]), line([25, 50], [68, 50])]),
  letter('G', 'grapes', '🍇', [[...arc(52, 50, 38, -50, 230, 20)], line([90, 55], [55, 55]), line([90, 55], [90, 80])]),
  letter('H', 'hat', '🎩', [line([20, 10], [20, 90]), line([80, 10], [80, 90]), line([20, 50], [80, 50])]),
  letter('I', 'ice cream', '🍦', [line([30, 10], [70, 10]), line([50, 10], [50, 90]), line([30, 90], [70, 90])]),
  letter('J', 'jam', '🍓', [[...line([60, 10], [60, 68]), ...arc(40, 68, 20, 0, 180, 10)], line([35, 10], [85, 10])]),
  letter('K', 'kite', '🪁', [line([22, 10], [22, 90]), line([78, 10], [22, 55]), line([40, 42], [80, 90])]),
  letter('L', 'lion', '🦁', [line([25, 10], [25, 90]), line([25, 90], [80, 90])]),
  letter('M', 'moon', '🌙', [line([12, 90], [12, 10]), line([12, 10], [50, 70]), line([50, 70], [88, 10]), line([88, 10], [88, 90])]),
  letter('N', 'nose', '👃', [line([18, 90], [18, 10]), line([18, 10], [82, 90]), line([82, 90], [82, 10])]),
  letter('O', 'orange', '🍊', [arc(50, 50, 38, -90, 270, 24)]),
  letter('P', 'pig', '🐷', [line([22, 90], [22, 10]), [...line([22, 10], [55, 10]), ...arc(55, 32, 22, -90, 90), ...line([55, 54], [22, 54])]]),
  letter('Q', 'queen', '👑', [arc(50, 48, 36, -90, 270, 24), line([62, 66], [88, 92])]),
  letter('R', 'rabbit', '🐰', [line([22, 90], [22, 10]), [...line([22, 10], [55, 10]), ...arc(55, 32, 22, -90, 90), ...line([55, 54], [22, 54])], line([45, 54], [82, 90])]),
  letter('S', 'star', '⭐', [[...arc(50, 30, 20, -30, -270, 14), ...arc(50, 70, 20, -90, 150, 14)]]),
  letter('T', 'tree', '🌳', [line([15, 10], [85, 10]), line([50, 10], [50, 90])]),
  letter('U', 'umbrella', '☂️', [[...line([20, 10], [20, 60]), ...arc(50, 60, 30, 180, 360, 14), ...line([80, 60], [80, 10])]]),
  letter('V', 'van', '🚐', [line([15, 10], [50, 90]), line([50, 90], [85, 10])]),
  letter('W', 'water', '💧', [line([8, 10], [28, 90]), line([28, 90], [50, 30]), line([50, 30], [72, 90]), line([72, 90], [92, 10])]),
  letter('X', 'xylophone', '🎶', [line([18, 10], [82, 90]), line([82, 10], [18, 90])]),
  letter('Y', 'yo-yo', '🪀', [line([15, 10], [50, 52]), line([85, 10], [50, 52]), line([50, 52], [50, 90])]),
  letter('Z', 'zebra', '🦓', [line([18, 10], [82, 10]), line([82, 10], [18, 90]), line([18, 90], [82, 90])]),
]

const shape = (id: string, name: string, emoji: string, strokes: readonly Stroke[], done = `A ${name}! Well done!`): TracePath => ({ id, name, label: emoji, strokes, done, emoji })

/** Simple pre-writing shapes and little pictures, easy first, trickier later. */
export const EASY_SHAPES: readonly TracePath[] = [
  shape('line-across', 'line', '➖', [line([10, 50], [90, 50])], 'A straight line! Well done!'),
  shape('line-down', 'line down', '⬇️', [line([50, 10], [50, 90])], 'Top to bottom! Well done!'),
  shape('circle', 'circle', '⭕', [arc(50, 50, 38, -90, 270, 24)]),
  shape('square', 'square', '🟦', [line([15, 15], [85, 15]), line([85, 15], [85, 85]), line([85, 85], [15, 85]), line([15, 85], [15, 15])]),
  shape('triangle', 'triangle', '🔺', [line([50, 12], [88, 88]), line([88, 88], [12, 88]), line([12, 88], [50, 12])]),
  shape('zigzag', 'zigzag', '⚡', [line([8, 70], [30, 30]), line([30, 30], [52, 70]), line([52, 70], [74, 30]), line([74, 30], [94, 70])]),
]

export const HARDER_SHAPES: readonly TracePath[] = [
  shape('wave', 'wave', '🌊', [[...arc(25, 50, 15, 180, 360, 10), ...arc(55, 50, 15, 180, 0, 10), ...arc(85, 50, 15, 180, 360, 10)]]),
  shape('house', 'house', '🏠', [line([15, 50], [50, 15]), line([50, 15], [85, 50]), line([85, 50], [85, 90]), line([85, 90], [15, 90]), line([15, 90], [15, 50])]),
  shape('star', 'star', '⭐', [line([50, 8], [62, 40]), line([62, 40], [94, 40]), line([94, 40], [68, 60]), line([68, 60], [78, 92]), line([78, 92], [50, 72]), line([50, 72], [22, 92]), line([22, 92], [32, 60]), line([32, 60], [6, 40]), line([6, 40], [38, 40]), line([38, 40], [50, 8])]),
  shape('heart', 'heart', '❤️', [[...arc(30, 35, 20, 180, 360, 10), ...arc(70, 35, 20, 180, 360, 10), ...line([90, 40], [50, 92]), ...line([50, 92], [10, 40])]]),
  shape('spiral', 'spiral', '🌀', [Array.from({ length: 40 }, (_, i) => { const t = i / 39; const a = t * Math.PI * 4; const r = 6 + t * 34; return P(50 + r * Math.cos(a), 50 + r * Math.sin(a)) })]),
  shape('boat', 'boat', '⛵', [line([20, 70], [80, 70]), line([80, 70], [70, 88]), line([70, 88], [30, 88]), line([30, 88], [20, 70]), line([50, 70], [50, 15]), line([50, 15], [75, 55]), line([75, 55], [50, 55])]),
]
