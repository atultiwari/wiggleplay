/** How the child interacts. Chosen in settings; every game honours it. */
export type InteractionMode = 'body' | 'hand' | 'finger' | 'head'

export type TrackingModel = 'hand' | 'pose'

export interface InteractionModeInfo {
  readonly id: InteractionMode
  readonly label: string
  readonly emoji: string
  readonly description: string
  readonly model: TrackingModel
  /** Spoken at the start of a game. */
  readonly tip: string
}

export const INTERACTION_MODES: readonly InteractionModeInfo[] = [
  {
    id: 'body',
    label: 'Whole body',
    emoji: '🧍',
    description: 'Hands, head, feet and tummy all count. Best for the youngest children.',
    model: 'pose',
    tip: 'Wiggle your hands, head or feet!',
  },
  {
    id: 'hand',
    label: 'Wave a hand',
    emoji: '🖐️',
    description: 'Any hand movement works. No pointing needed.',
    model: 'hand',
    tip: 'Wave your hand!',
  },
  {
    id: 'finger',
    label: 'Point a finger',
    emoji: '☝️',
    description: 'Precise fingertip control for older children.',
    model: 'hand',
    tip: 'Point one finger at the camera!',
  },
  {
    id: 'head',
    label: 'Head only',
    emoji: '🙂',
    description: 'Move the head to play. Handy when sitting or for limited mobility.',
    model: 'pose',
    tip: 'Move your head!',
  },
]

export const INTERACTION_MODE_IDS: readonly InteractionMode[] = INTERACTION_MODES.map((m) => m.id)

export const modeInfo = (id: InteractionMode): InteractionModeInfo =>
  INTERACTION_MODES.find((m) => m.id === id) ?? INTERACTION_MODES[0]
