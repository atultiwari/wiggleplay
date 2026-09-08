/**
 * Lightweight local progress log. Feeds the future adaptive layer and the
 * parent summary. Nothing leaves the device.
 */
export interface ProgressEvent {
  readonly game: string
  readonly skill: string
  readonly detail?: string
  readonly at: number
}

export interface SkillSummary {
  readonly skill: string
  readonly count: number
}

export interface ProgressSummary {
  readonly totalEvents: number
  readonly perGame: Readonly<Record<string, number>>
  readonly topSkills: readonly SkillSummary[]
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PROGRESS_KEY = 'wiggleplay.progress.v1'
export const MAX_EVENTS = 500

const safeStore = (): KeyValueStore | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

const isEvent = (value: unknown): value is ProgressEvent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ProgressEvent).game === 'string' &&
  typeof (value as ProgressEvent).skill === 'string' &&
  typeof (value as ProgressEvent).at === 'number'

export const readEvents = (store: KeyValueStore | null = safeStore()): ProgressEvent[] => {
  if (!store) return []
  try {
    const raw = store.getItem(PROGRESS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEvent) : []
  } catch (error) {
    console.warn('[progress] could not read events', error)
    return []
  }
}

export const appendEvent = (events: readonly ProgressEvent[], event: ProgressEvent): ProgressEvent[] =>
  [...events, event].slice(-MAX_EVENTS)

export const recordEvent = (
  event: Omit<ProgressEvent, 'at'>,
  store: KeyValueStore | null = safeStore(),
  now: () => number = () => Date.now(),
): void => {
  if (!store) return
  try {
    const next = appendEvent(readEvents(store), { ...event, at: now() })
    store.setItem(PROGRESS_KEY, JSON.stringify(next))
  } catch (error) {
    console.warn('[progress] could not save event', error)
  }
}

export const summarize = (events: readonly ProgressEvent[]): ProgressSummary => {
  const perGame = events.reduce<Record<string, number>>(
    (acc, e) => ({ ...acc, [e.game]: (acc[e.game] ?? 0) + 1 }),
    {},
  )
  const skillCounts = events.reduce<Record<string, number>>(
    (acc, e) => ({ ...acc, [e.skill]: (acc[e.skill] ?? 0) + 1 }),
    {},
  )
  const topSkills = Object.entries(skillCounts)
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
  return { totalEvents: events.length, perGame, topSkills }
}
