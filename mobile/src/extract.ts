import { Directory, File } from 'expo-file-system'
import { unzipSync } from 'fflate'

export interface ExtractProgress {
  readonly done: number
  readonly total: number
  readonly file: string
}

/**
 * Reads a whole local file as bytes. The legacy base64 API needs ~2.7x the file size as a Java
 * string, which is too much for a 40 MB games bundle on a phone; the File API streams bytes.
 */
export const readFileBytes = async (uri: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await new File(uri).arrayBuffer())

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

const ensureDir = (dir: string, made: Set<string>): void => {
  if (made.has(dir)) return
  new Directory(dir).create({ intermediates: true, idempotent: true })
  made.add(dir)
}

/** Unpacks a stored zip into `dir` (replacing it), writing raw bytes straight to disk. */
export const extractZip = async (zip: Uint8Array, dir: string, onProgress?: (progress: ExtractProgress) => void): Promise<void> => {
  const entries = unzipSync(zip)
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'))
  if (!names.includes('index.html')) throw new Error('The games bundle is missing its start page.')
  const root = new Directory(dir)
  if (root.exists) root.delete()
  const made = new Set<string>()
  ensureDir(dir, made)
  for (const [index, name] of names.entries()) {
    const target = `${dir}/${name}`
    ensureDir(parentOf(target), made)
    const file = new File(target)
    file.create({ overwrite: true })
    file.write(entries[name])
    onProgress?.({ done: index + 1, total: names.length, file: name })
    // Let the UI breathe between files; the writes above are synchronous native calls.
    if (index % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
