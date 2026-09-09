import * as Crypto from 'expo-crypto'
import * as FileSystem from 'expo-file-system/legacy'
import { BUNDLED_VERSION, webRootDir } from './bundle'
import { extractZip, readFileBytes } from './extract'
import { hexOf, isManifest, isNewerVersion, MANIFEST_URL, statusFor, type UpdateManifest, type UpdateStatus } from './manifest'

const CHECK_TIMEOUT_MS = 8000
const bundlesDir = () => `${FileSystem.documentDirectory}bundles`
const currentFile = () => `${FileSystem.documentDirectory}current-bundle.json`

interface Current {
  readonly version: string
  readonly dir: string
}

/** The games directory to serve: a downloaded bundle newer than the built-in one, else the built-in copy. */
export const activeBundle = async (): Promise<Current> => {
  try {
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(currentFile()))
    if (typeof parsed === 'object' && parsed !== null) {
      const current = parsed as Partial<Current>
      if (typeof current.version === 'string' && typeof current.dir === 'string' && isNewerVersion(current.version, BUNDLED_VERSION)) {
        const info = await FileSystem.getInfoAsync(`${current.dir}/index.html`)
        if (info.exists) return { version: current.version, dir: current.dir }
      }
    }
  } catch {
    /* nothing downloaded yet */
  }
  return { version: BUNDLED_VERSION, dir: webRootDir() }
}

const fetchManifest = async (): Promise<UpdateManifest | 'offline' | 'invalid'> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { signal: controller.signal, headers: { 'cache-control': 'no-cache' } })
    if (!response.ok) return 'offline'
    const parsed: unknown = await response.json()
    return isManifest(parsed) ? parsed : 'invalid'
  } catch {
    return 'offline'
  } finally {
    clearTimeout(timer)
  }
}

/** Checks, downloads, verifies and unpacks content updates for the phone; the app restarts its server to apply. */
export class MobileUpdater {
  private status: UpdateStatus
  private manifest: UpdateManifest | null = null

  constructor(current: string, private readonly onStatus: (status: UpdateStatus) => void) {
    this.status = { state: 'idle', current }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status
    this.onStatus(status)
    return status
  }

  async check(): Promise<UpdateStatus> {
    const previous = this.status
    this.set({ ...previous, state: 'checking', message: undefined })
    const manifest = await fetchManifest()
    if (manifest === 'offline') return this.set({ ...this.status, state: 'offline' })
    if (manifest === 'invalid') return this.set({ ...this.status, state: 'error', message: 'The update list could not be read.' })
    this.manifest = manifest
    return this.set(statusFor(manifest, previous.current, previous))
  }

  async download(): Promise<UpdateStatus> {
    const manifest = this.manifest
    if (!manifest || this.status.state !== 'available') return this.status
    const zipPath = `${FileSystem.cacheDirectory}web-${manifest.version}.zip`
    const target = `${bundlesDir()}/${manifest.version}`
    try {
      this.set({ ...this.status, state: 'downloading', progress: 0 })
      const download = FileSystem.createDownloadResumable(manifest.zip, zipPath, {}, (p) => {
        const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : manifest.bytes
        this.set({ ...this.status, state: 'downloading', progress: Math.min(0.9, (0.9 * p.totalBytesWritten) / total) })
      })
      const result = await download.downloadAsync()
      if (!result || result.status !== 200) throw new Error('The download did not finish. Please try again.')
      const zip = await readFileBytes(zipPath)
      const digest = hexOf(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, zip))
      if (digest !== manifest.sha256) throw new Error('The downloaded file was damaged; please try again.')
      await extractZip(zip, target, (p) => this.set({ ...this.status, state: 'downloading', progress: 0.9 + (0.1 * p.done) / p.total }))
      await FileSystem.writeAsStringAsync(currentFile(), JSON.stringify({ version: manifest.version, dir: target } satisfies Current))
      return this.set({ ...this.status, state: 'ready', progress: 1, latest: manifest.version })
    } catch (error) {
      return this.set({ ...this.status, state: 'error', message: error instanceof Error ? error.message : 'The download failed.' })
    } finally {
      await FileSystem.deleteAsync(zipPath, { idempotent: true }).catch(() => undefined)
    }
  }
}
