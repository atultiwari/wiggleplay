import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { unzipSync } from 'fflate'
import manifest from '../assets/web-manifest.json'
import { fromBase64, toBase64 } from './base64'

export interface ExtractProgress {
  readonly done: number
  readonly total: number
  readonly file: string
}

/** Where the unpacked web app lives on the device; served by the local static server. */
export const webRootDir = (): string => `${FileSystem.documentDirectory}web`
const versionFile = () => `${webRootDir()}/.wiggleplay-version`

const CHUNK = 0x8000

/** True when the unpacked copy matches the bundle inside this build of the app. */
export const isExtracted = async (): Promise<boolean> => {
  try {
    const info = await FileSystem.getInfoAsync(versionFile())
    if (!info.exists) return false
    return (await FileSystem.readAsStringAsync(versionFile())) === manifest.version
  } catch {
    return false
  }
}

const readBundledZip = async (): Promise<Uint8Array> => {
  const asset = Asset.fromModule(require('../assets/web.zip'))
  await asset.downloadAsync()
  const uri = asset.localUri ?? asset.uri
  try {
    const response = await fetch(uri)
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return fromBase64(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }))
  }
}

const ensureDir = async (dir: string, made: Set<string>) => {
  if (made.has(dir)) return
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined)
  made.add(dir)
}

/**
 * Unpacks the bundled web app into the document directory (once per app version).
 * Everything the games need, including the MediaPipe runtime and models, is inside, so the app
 * never touches the network afterwards.
 */
export const ensureWebRoot = async (onProgress?: (progress: ExtractProgress) => void): Promise<string> => {
  if (await isExtracted()) return webRootDir()
  const zip = await readBundledZip()
  const entries = unzipSync(zip)
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'))
  await FileSystem.deleteAsync(webRootDir(), { idempotent: true })
  const made = new Set<string>()
  await ensureDir(webRootDir(), made)
  for (const [index, name] of names.entries()) {
    const target = `${webRootDir()}/${name}`
    await ensureDir(target.slice(0, target.lastIndexOf('/')), made)
    const data = entries[name]
    let base64 = ''
    for (let i = 0; i < data.length; i += CHUNK * 3) base64 += toBase64(data.subarray(i, Math.min(data.length, i + CHUNK * 3)))
    await FileSystem.writeAsStringAsync(target, base64, { encoding: FileSystem.EncodingType.Base64 })
    onProgress?.({ done: index + 1, total: names.length, file: name })
  }
  await FileSystem.writeAsStringAsync(versionFile(), manifest.version)
  return webRootDir()
}
