import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

/** Mirrors src/lib/host/types.ts in the web app. */
export interface UpdateManifest {
  readonly version: string
  readonly zip: string
  readonly bytes: number
  readonly sha256: string
  readonly notes?: string
  readonly desktop?: { readonly version: string; readonly releases: string }
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
  readonly shellUpdateUrl?: string
}

export const DEFAULT_MANIFEST_URL = 'https://atultiwari.github.io/wiggleplay/updates/manifest.json'

export const versionStamp = (version: string): number => Number((version.match(/^(\d{8,14})/) ?? [])[1] ?? 0)
export const isNewerVersion = (candidate: string, current: string): boolean => versionStamp(candidate) > versionStamp(current)
const isManifest = (v: unknown): v is UpdateManifest =>
  typeof v === 'object' && v !== null && typeof (v as UpdateManifest).version === 'string' && typeof (v as UpdateManifest).zip === 'string' && typeof (v as UpdateManifest).sha256 === 'string'

/** Simple semver-ish compare for the shell version (0.1.0 style). */
export const isNewerShell = (candidate: string, current: string): boolean => {
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

export interface BundleStore {
  /** Root that holds bundles/<version>/ and current.json. */
  readonly dir: string
  readonly bundledVersion: string
  readonly bundledDir: string
}

interface Current {
  readonly version: string
  readonly dir: string
}

const currentFile = (store: BundleStore) => join(store.dir, 'current.json')

/** The directory the app should serve right now: a downloaded bundle when one is active, else the built-in one. */
export const activeBundle = async (store: BundleStore): Promise<Current> => {
  try {
    const current = JSON.parse(await readFile(currentFile(store), 'utf8')) as Current
    if (current.version && existsSync(join(current.dir, 'index.html')) && isNewerVersion(current.version, store.bundledVersion)) return current
  } catch {
    /* no downloaded bundle yet */
  }
  return { version: store.bundledVersion, dir: store.bundledDir }
}

export interface UpdaterOptions {
  readonly store: BundleStore
  readonly shellVersion: string
  readonly manifestUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly onStatus?: (status: UpdateStatus) => void
}

/** Checks, downloads, verifies and unpacks content updates; the caller decides when to restart. */
export class Updater {
  private status: UpdateStatus
  private manifest: UpdateManifest | null = null

  constructor(private readonly options: UpdaterOptions, current: string) {
    this.status = { state: 'idle', current }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status
    this.options.onStatus?.(status)
    return status
  }

  async check(): Promise<UpdateStatus> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const previous = this.status
    this.set({ ...previous, state: 'checking', message: undefined })
    let manifest: unknown
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const response = await fetchImpl(`${this.options.manifestUrl ?? DEFAULT_MANIFEST_URL}?t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`manifest ${response.status}`)
      manifest = await response.json()
    } catch {
      return this.set({ ...this.status, state: 'offline' })
    }
    if (!isManifest(manifest)) return this.set({ ...this.status, state: 'error', message: 'The update list could not be read.' })
    this.manifest = manifest
    const shellUpdateUrl = manifest.desktop && isNewerShell(manifest.desktop.version, this.options.shellVersion) ? manifest.desktop.releases : undefined
    if (previous.state === 'ready' && previous.latest === manifest.version) return this.set({ ...previous, shellUpdateUrl })
    if (!isNewerVersion(manifest.version, this.status.current)) return this.set({ state: 'up-to-date', current: this.status.current, shellUpdateUrl })
    return this.set({ state: 'available', current: this.status.current, latest: manifest.version, bytes: manifest.bytes, notes: manifest.notes, shellUpdateUrl })
  }

  async download(): Promise<UpdateStatus> {
    const manifest = this.manifest
    if (!manifest || this.status.state !== 'available') return this.status
    const fetchImpl = this.options.fetchImpl ?? fetch
    const { store } = this.options
    const target = join(store.dir, 'bundles', manifest.version)
    const zipPath = join(store.dir, 'downloads', `${manifest.version}.zip`)
    try {
      this.set({ ...this.status, state: 'downloading', progress: 0 })
      const response = await fetchImpl(manifest.zip)
      if (!response.ok || !response.body) throw new Error(`download ${response.status}`)
      await mkdir(dirname(zipPath), { recursive: true })
      const chunks: Uint8Array[] = []
      let received = 0
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        this.set({ ...this.status, state: 'downloading', progress: Math.min(0.99, received / manifest.bytes) })
      }
      const zip = Buffer.concat(chunks)
      const digest = createHash('sha256').update(zip).digest('hex')
      if (digest !== manifest.sha256) throw new Error('The downloaded file was damaged; please try again.')
      await writeFile(zipPath, zip)
      await rm(target, { recursive: true, force: true })
      const staging = `${target}.part`
      await rm(staging, { recursive: true, force: true })
      const entries = unzipSync(new Uint8Array(zip))
      for (const [name, data] of Object.entries(entries)) {
        if (name.endsWith('/')) continue
        const file = join(staging, name)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, data)
      }
      await rename(staging, target)
      await writeFile(currentFile(store), JSON.stringify({ version: manifest.version, dir: target } satisfies Current))
      await rm(zipPath, { force: true })
      return this.set({ ...this.status, state: 'ready', progress: 1, latest: manifest.version })
    } catch (error) {
      return this.set({ ...this.status, state: 'error', message: error instanceof Error ? error.message : 'The download failed.' })
    }
  }
}
