import type { Point } from '../math/vec'
import { distance } from '../math/vec'
import type { TracePath } from './paths'

export interface Gem {
  readonly id: number
  readonly x: number
  readonly y: number
  /** Which stroke of the path the gem sits on. */
  readonly stroke: number
  readonly collected: boolean
}

export interface TraceBox {
  readonly x: number
  readonly y: number
  readonly size: number
}

export interface TraceState {
  readonly path: TracePath
  readonly gems: readonly Gem[]
  /** Pixel polylines of the strokes for drawing the guide. */
  readonly guides: readonly (readonly Point[])[]
  readonly box: TraceBox
  /** Index of the next gem the child should reach. */
  readonly next: number
  readonly completeSec: number
  readonly idleSec: number
  /** Recent finger positions for the sparkle trail. */
  readonly trail: readonly Point[]
  readonly completed: number
}

export interface TraceConfig {
  /** Multiplies the gem spacing and hit radius. */
  readonly gemSize: number
}

export interface TraceInput {
  readonly touches: readonly Point[]
  readonly width: number
  readonly height: number
  readonly config?: TraceConfig
}

export interface TraceEvents {
  readonly collected: readonly Gem[]
  readonly completed: boolean
  /** True on the frame the celebration ends and the caller should load the next path. */
  readonly advance: boolean
  readonly hint: boolean
}

export const DEFAULT_TRACE_CONFIG: TraceConfig = { gemSize: 1 }
export const CELEBRATE_SEC = 2.6
export const HINT_SEC = 7
/** Base spacing between gems as a fraction of the box; the hit radius is generous for little fingers. */
export const GEM_SPACING = 0.11
export const HIT_RADIUS = 0.085
/** How many gems ahead of the next one may be picked up, so a wobbly finger still counts. */
export const LOOKAHEAD = 3
const TRAIL_LENGTH = 14

/** Largest square that fits the stage with a margin for the label. */
export const fitBox = (width: number, height: number): TraceBox => {
  const size = Math.min(width * 0.62, height * 0.86)
  return { x: (width - size) / 2 + width * 0.06, y: (height - size) / 2, size }
}

const toPixel = (p: Point, box: TraceBox): Point => ({ x: box.x + (p.x / 100) * box.size, y: box.y + (p.y / 100) * box.size })

/** Samples gems evenly along every stroke (always including the first and last point of each). */
export const sampleGems = (path: TracePath, box: TraceBox, spacing: number): Gem[] => {
  const gems: Gem[] = []
  path.strokes.forEach((stroke, strokeIndex) => {
    const pts = stroke.map((p) => toPixel(p, box))
    let carry = 0
    let placed = false
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i]
      const b = pts[i + 1]
      const seg = distance(a, b)
      let t = placed ? spacing - carry : 0
      while (t <= seg) {
        const k = seg === 0 ? 0 : t / seg
        gems.push({ id: gems.length, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, stroke: strokeIndex, collected: false })
        placed = true
        t += spacing
      }
      carry = seg - (t - spacing)
    }
    const last = pts[pts.length - 1]
    const tail = gems[gems.length - 1]
    if (!tail || tail.stroke !== strokeIndex || distance(tail, last) > spacing * 0.4) gems.push({ id: gems.length, ...last, stroke: strokeIndex, collected: false })
  })
  return gems
}

export const createTraceState = (path: TracePath, width: number, height: number, config: TraceConfig = DEFAULT_TRACE_CONFIG, completed = 0): TraceState => {
  const box = fitBox(width, height)
  return {
    path,
    gems: sampleGems(path, box, box.size * GEM_SPACING * config.gemSize),
    guides: path.strokes.map((stroke) => stroke.map((p) => toPixel(p, box))),
    box,
    next: 0,
    completeSec: 0,
    idleSec: 0,
    trail: [],
    completed,
  }
}

export const traceProgress = (state: TraceState): number => (state.gems.length === 0 ? 1 : state.gems.filter((g) => g.collected).length / state.gems.length)

export const stepTrace = (state: TraceState, dtSec: number, input: TraceInput): { readonly state: TraceState; readonly events: TraceEvents } => {
  const config = input.config ?? DEFAULT_TRACE_CONFIG
  const radius = state.box.size * HIT_RADIUS * config.gemSize
  const none: TraceEvents = { collected: [], completed: false, advance: false, hint: false }
  const trail = input.touches.length > 0 ? [...state.trail, ...input.touches].slice(-TRAIL_LENGTH) : state.trail.slice(1)

  if (state.completeSec > 0) {
    const completeSec = state.completeSec - dtSec
    return { state: { ...state, completeSec: Math.max(0, completeSec), trail }, events: { ...none, advance: completeSec <= 0 } }
  }

  const reachable = state.gems.slice(state.next, state.next + LOOKAHEAD)
  const hit = reachable.filter((gem) => !gem.collected && input.touches.some((t) => distance(t, gem) <= radius))
  if (hit.length === 0) {
    const idleSec = state.idleSec + dtSec
    const hint = idleSec >= HINT_SEC
    return { state: { ...state, idleSec: hint ? 0 : idleSec, trail }, events: { ...none, hint } }
  }
  const hitIds = new Set(hit.map((g) => g.id))
  const gems = state.gems.map((gem) => (hitIds.has(gem.id) ? { ...gem, collected: true } : gem))
  let next = state.next
  while (next < gems.length && gems[next].collected) next += 1
  const completed = next >= gems.length
  return {
    state: { ...state, gems, next, idleSec: 0, trail, completeSec: completed ? CELEBRATE_SEC : 0, completed: state.completed + (completed ? 1 : 0) },
    events: { ...none, collected: hit, completed },
  }
}

/** The gem the child should aim for next, or null when the path is done. */
export const nextGem = (state: TraceState): Gem | null => state.gems[state.next] ?? null
