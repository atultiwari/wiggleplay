/** Pure helpers for content updates (mirrors src/lib/host/types.ts in the web app); node-testable. */
export interface UpdateManifest {
  readonly version: string
  readonly zip: string
  readonly bytes: number
  readonly sha256: string
  readonly notes?: string
}

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'offline' | 'error'

export interface UpdateStatus {
  readonly state: UpdateState
  readonly current: string
  readonly latest?: string
  readonly progress?: number
  readonly bytes?: number
  readonly notes?: string
  readonly message?: string
}

export const MANIFEST_URL = 'https://atultiwari.github.io/wiggleplay/updates/manifest.json'

export const versionStamp = (version: string): number => Number((version.match(/^(\d{8,14})/) ?? [])[1] ?? 0)
export const isNewerVersion = (candidate: string, current: string): boolean => versionStamp(candidate) > versionStamp(current)
export const isManifest = (v: unknown): v is UpdateManifest =>
  typeof v === 'object' && v !== null && typeof (v as UpdateManifest).version === 'string' && typeof (v as UpdateManifest).zip === 'string' && typeof (v as UpdateManifest).sha256 === 'string' && typeof (v as UpdateManifest).bytes === 'number'

export const hexOf = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')

/** Decides what a fetched manifest means for the running bundle. */
export const statusFor = (manifest: UpdateManifest, current: string, previous: UpdateStatus): UpdateStatus => {
  if (previous.state === 'ready' && previous.latest === manifest.version) return previous
  if (!isNewerVersion(manifest.version, current)) return { state: 'up-to-date', current }
  return { state: 'available', current, latest: manifest.version, bytes: manifest.bytes, notes: manifest.notes }
}
