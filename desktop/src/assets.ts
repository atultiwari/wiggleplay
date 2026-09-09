import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The runtime files the tracking needs: the MediaPipe WASM runtime and the two landmark models.
 * They ship inside the app, but a "lite" build (or a damaged install) can fetch them on first run;
 * after that the app never needs the internet again.
 */
export interface RuntimeAsset {
  /** Path relative to the web root, e.g. mediapipe/wasm/vision_wasm_internal.wasm. */
  readonly path: string
  /** Minimum size in bytes: a shorter file is treated as damaged and re-downloaded. */
  readonly minBytes: number
}

export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { path: 'mediapipe/wasm/vision_wasm_internal.js', minBytes: 100_000 },
  { path: 'mediapipe/wasm/vision_wasm_internal.wasm', minBytes: 8_000_000 },
  { path: 'mediapipe/wasm/vision_wasm_nosimd_internal.js', minBytes: 100_000 },
  { path: 'mediapipe/wasm/vision_wasm_nosimd_internal.wasm', minBytes: 8_000_000 },
  { path: 'models/hand_landmarker.task', minBytes: 7_000_000 },
  { path: 'models/pose_landmarker_lite.task', minBytes: 5_000_000 },
]

/** Where the assets are downloaded from when they are not bundled: the published web app. */
export const DEFAULT_ASSET_ORIGIN = 'https://atultiwari.github.io/wiggleplay/'

export interface AssetProgress {
  readonly file: string
  readonly index: number
  readonly total: number
  readonly receivedBytes: number
  readonly totalBytes: number | null
}

export interface AssetLocator {
  /** Directories searched in order; the first that has a valid copy wins. */
  readonly searchDirs: readonly string[]
  /** Where missing files are downloaded to. */
  readonly downloadDir: string
  readonly origin?: string
  readonly fetchImpl?: typeof fetch
  readonly onProgress?: (progress: AssetProgress) => void
}

const isValid = async (file: string, minBytes: number): Promise<boolean> => {
  try {
    const info = await stat(file)
    return info.isFile() && info.size >= minBytes
  } catch {
    return false
  }
}

/** Resolves an asset to a real file, or null when no valid copy exists yet. */
export const findAsset = async (asset: RuntimeAsset, searchDirs: readonly string[]): Promise<string | null> => {
  for (const dir of searchDirs) {
    const candidate = join(dir, asset.path)
    if (await isValid(candidate, asset.minBytes)) return candidate
  }
  return null
}

export const missingAssets = async (locator: AssetLocator): Promise<readonly RuntimeAsset[]> => {
  const checks = await Promise.all(RUNTIME_ASSETS.map(async (asset) => ((await findAsset(asset, locator.searchDirs)) ? null : asset)))
  return checks.filter((asset): asset is RuntimeAsset => asset !== null)
}

const downloadOne = async (asset: RuntimeAsset, index: number, total: number, locator: AssetLocator): Promise<void> => {
  const fetchImpl = locator.fetchImpl ?? fetch
  const url = new URL(asset.path, locator.origin ?? DEFAULT_ASSET_ORIGIN).toString()
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) throw new Error(`Could not download ${asset.path} (${response.status})`)
  const target = join(locator.downloadDir, asset.path)
  const partial = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  const totalBytes = Number(response.headers.get('content-length')) || null
  let receivedBytes = 0
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength
      locator.onProgress?.({ file: asset.path, index, total, receivedBytes, totalBytes })
      controller.enqueue(chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counted) as import('node:stream/web').ReadableStream), createWriteStream(partial))
  if (!(await isValid(partial, asset.minBytes))) {
    await unlink(partial).catch(() => undefined)
    throw new Error(`Downloaded ${asset.path} is incomplete`)
  }
  await rename(partial, target)
}

/**
 * Makes sure every runtime asset is available locally, downloading the ones that are not.
 * Returns the list that had to be downloaded (empty when the app was already complete).
 */
export const ensureAssets = async (locator: AssetLocator): Promise<readonly RuntimeAsset[]> => {
  const missing = await missingAssets(locator)
  for (const [i, asset] of missing.entries()) await downloadOne(asset, i, missing.length, locator)
  return missing
}
