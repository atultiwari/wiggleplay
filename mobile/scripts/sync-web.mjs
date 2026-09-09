// Builds the web app and packs it into assets/web.zip (stored, not compressed, so the phone can
// unpack it quickly on first launch). The manifest carries a version stamp so an app update
// re-extracts the bundle. Run before `expo prebuild` / `expo run:*`.
import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = resolve(here, '..')
const webRoot = resolve(mobile, '..')
const dist = resolve(webRoot, 'dist')

execSync('npm run build', { cwd: webRoot, stdio: 'inherit', env: { ...process.env, VITE_BASE_PATH: '/' } })

/** The tracker only ever loads the SIMD or the no-SIMD runtime; the third variant is dead weight on a phone. */
const SKIP = /vision_wasm_module_internal|\.map$/

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const files = {}
let bytes = 0
for (const full of walk(dist)) {
  const rel = relative(dist, full).split('\\').join('/')
  if (SKIP.test(rel)) continue
  const data = readFileSync(full)
  files[rel] = [new Uint8Array(data), { level: 0 }]
  bytes += data.byteLength
}
const zipped = zipSync(files)
mkdirSync(resolve(mobile, 'assets'), { recursive: true })
writeFileSync(resolve(mobile, 'assets/web.zip'), zipped)
const version = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${execSync('git rev-parse --short HEAD', { cwd: webRoot }).toString().trim()}`
writeFileSync(resolve(mobile, 'assets/web-manifest.json'), JSON.stringify({ version, files: Object.keys(files).length, bytes }, null, 2))
console.log(`[sync-web] packed ${Object.keys(files).length} files (${(bytes / 1048576).toFixed(1)} MB) as assets/web.zip, version ${version}`)
