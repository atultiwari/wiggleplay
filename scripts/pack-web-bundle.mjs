// Packs a built web app (base path "/") into one stored zip plus a manifest describing it.
// Used by CI to publish content updates and by the mobile shell to embed its first bundle.
//
//   node scripts/pack-web-bundle.mjs <distDir> <outDir> [--zip-name web.zip] [--site https://.../]
//
// Writes <outDir>/<zip-name> and <outDir>/manifest.json:
//   { version, zip, bytes, sha256, files, notes, desktop: { version, releases } }
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { buildVersion } from './build-version.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const distDir = resolve(args[0] ?? 'dist')
const outDir = resolve(args[1] ?? 'dist/updates')
const zipName = flag('--zip-name', null)
const site = flag('--site', 'https://atultiwari.github.io/wiggleplay/')
const root = resolve(import.meta.dirname, '..')

/** The tracker only ever loads the SIMD or the no-SIMD runtime; the third variant is dead weight. */
const SKIP = /vision_wasm_module_internal|\.map$|^updates\//

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const version = buildVersion()
const files = {}
let bytes = 0
for (const full of walk(distDir)) {
  const rel = relative(distDir, full).split('\\').join('/')
  if (SKIP.test(rel)) continue
  const data = readFileSync(full)
  files[rel] = [new Uint8Array(data), { level: 0 }]
  bytes += data.byteLength
}
if (!files['index.html']) throw new Error(`no index.html in ${distDir}`)
const zipped = zipSync(files)
const name = zipName ?? `web-${version}.zip`
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, name), zipped)
let notes = ''
try {
  notes = execSync('git log -1 --pretty=%s', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {
  /* ignore */
}
const desktopVersion = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version
const manifest = {
  version,
  zip: new URL(`updates/${name}`, site).toString(),
  bytes: zipped.byteLength,
  sha256: createHash('sha256').update(zipped).digest('hex'),
  files: Object.keys(files).length,
  publishedAt: new Date().toISOString(),
  notes,
  desktop: { version: desktopVersion, releases: 'https://github.com/atultiwari/wiggleplay/releases/latest' },
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[pack-web-bundle] ${name}: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB, version ${version}`)
