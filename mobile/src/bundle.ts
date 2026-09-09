import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import manifest from '../assets/web-manifest.json'
import { fromBase64 } from './base64'
import { extractZip, type ExtractProgress } from './extract'

export type { ExtractProgress } from './extract'

/** Version of the games bundle shipped inside this build of the app. */
export const BUNDLED_VERSION: string = manifest.version

/** Where the unpacked web app lives on the device; served by the local static server. */
export const webRootDir = (): string => `${FileSystem.documentDirectory}web`
const versionFile = () => `${webRootDir()}/.wiggleplay-version`

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

/**
 * Unpacks the bundled web app into the document directory (once per app version).
 * Everything the games need, including the MediaPipe runtime and models, is inside, so the app
 * never touches the network afterwards.
 */
export const ensureWebRoot = async (onProgress?: (progress: ExtractProgress) => void): Promise<string> => {
  if (await isExtracted()) return webRootDir()
  await extractZip(await readBundledZip(), webRootDir(), onProgress)
  await FileSystem.writeAsStringAsync(versionFile(), manifest.version)
  return webRootDir()
}
