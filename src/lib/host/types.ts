/**
 * The bridge a native shell (desktop or mobile) exposes to the web app as `window.wigglePlayHost`.
 * The website has no host: it is always current on reload.
 */
export type HostKind = 'desktop' | 'android' | 'ios'

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'offline' | 'error'

export interface UpdateStatus {
  readonly state: UpdateState
  /** Version of the games bundle currently running. */
  readonly current: string
  /** Newest version known from the update server, when different. */
  readonly latest?: string
  /** 0..1 while downloading. */
  readonly progress?: number
  readonly bytes?: number
  readonly notes?: string
  readonly message?: string
  /** Newer app shell (installer) available: a link the parent can open. */
  readonly shellUpdateUrl?: string
}

export interface HostBridge {
  readonly kind: HostKind
  readonly appVersion: string
  readonly checkForUpdates: () => Promise<UpdateStatus>
  readonly downloadUpdate: () => Promise<UpdateStatus>
  readonly applyUpdate: () => Promise<void>
  readonly getStatus: () => Promise<UpdateStatus>
  readonly onStatus: (listener: (status: UpdateStatus) => void) => () => void
  readonly openExternal?: (url: string) => void
}

/** The manifest published next to the website (scripts/pack-web-bundle.mjs). */
export interface UpdateManifest {
  readonly version: string
  readonly zip: string
  readonly bytes: number
  readonly sha256: string
  readonly files: number
  readonly notes?: string
  readonly desktop?: { readonly version: string; readonly releases: string }
}

export const UPDATE_MANIFEST_URL = 'https://atultiwari.github.io/wiggleplay/updates/manifest.json'

/** Bundle versions are `YYYYMMDDHHMMSS-sha`; only the date part orders them. */
export const versionStamp = (version: string): number => Number((version.match(/^(\d{8,14})/) ?? [])[1] ?? 0)

export const isNewerVersion = (candidate: string, current: string): boolean => versionStamp(candidate) > versionStamp(current)

export const isUpdateManifest = (value: unknown): value is UpdateManifest =>
  typeof value === 'object' && value !== null && typeof (value as UpdateManifest).version === 'string' && typeof (value as UpdateManifest).zip === 'string' && typeof (value as UpdateManifest).sha256 === 'string' && typeof (value as UpdateManifest).bytes === 'number'
