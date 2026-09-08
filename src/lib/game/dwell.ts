/**
 * "Dwell" selection: hover a hand over a target for a while to select it.
 * This is how toddlers press buttons without touching anything.
 */
export interface DwellState {
  readonly targetId: string | null
  readonly elapsedMs: number
  readonly fired: boolean
}

export const DWELL_IDLE: DwellState = { targetId: null, elapsedMs: 0, fired: false }

export interface DwellUpdate {
  readonly state: DwellState
  /** Target id that just completed its dwell this frame, if any. */
  readonly triggered: string | null
}

export const updateDwell = (
  state: DwellState,
  targetId: string | null,
  dtMs: number,
  thresholdMs: number,
): DwellUpdate => {
  if (targetId === null) return { state: DWELL_IDLE, triggered: null }
  if (targetId !== state.targetId) {
    return { state: { targetId, elapsedMs: 0, fired: false }, triggered: null }
  }
  if (state.fired) return { state, triggered: null }
  const elapsedMs = state.elapsedMs + dtMs
  if (elapsedMs >= thresholdMs) {
    return { state: { targetId, elapsedMs: thresholdMs, fired: true }, triggered: targetId }
  }
  return { state: { targetId, elapsedMs, fired: false }, triggered: null }
}

export const dwellProgress = (state: DwellState, thresholdMs: number): number =>
  thresholdMs <= 0 ? 1 : Math.min(1, state.elapsedMs / thresholdMs)
