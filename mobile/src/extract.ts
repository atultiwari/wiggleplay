import * as FileSystem from 'expo-file-system/legacy'
import { unzipSync } from 'fflate'
import { toBase64 } from './base64'

export interface ExtractProgress {
  readonly done: number
  readonly total: number
  readonly file: string
}

const CHUNK = 0x8000

const ensureDir = async (dir: string, made: Set<string>): Promise<void> => {
  if (made.has(dir)) return
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined)
  made.add(dir)
}

const encode = (data: Uint8Array): string => {
  let base64 = ''
  for (let i = 0; i < data.length; i += CHUNK * 3) base64 += toBase64(data.subarray(i, Math.min(data.length, i + CHUNK * 3)))
  return base64
}

/** Unpacks a stored zip into `dir` (replacing it), writing files through the legacy file-system API. */
export const extractZip = async (zip: Uint8Array, dir: string, onProgress?: (progress: ExtractProgress) => void): Promise<void> => {
  const entries = unzipSync(zip)
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'))
  if (!names.includes('index.html')) throw new Error('The games bundle is missing its start page.')
  await FileSystem.deleteAsync(dir, { idempotent: true })
  const made = new Set<string>()
  await ensureDir(dir, made)
  for (const [index, name] of names.entries()) {
    const target = `${dir}/${name}`
    await ensureDir(target.slice(0, target.lastIndexOf('/')), made)
    await FileSystem.writeAsStringAsync(target, encode(entries[name]), { encoding: FileSystem.EncodingType.Base64 })
    onProgress?.({ done: index + 1, total: names.length, file: name })
  }
}
