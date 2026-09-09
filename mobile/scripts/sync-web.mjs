// Builds the web app and packs it into assets/web.zip (stored, not compressed, so the phone can
// unpack it quickly on first launch). Uses the shared packer so the version stamp matches what
// the update server publishes. Run before `expo prebuild` / `expo run:*`.
import { execSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = resolve(here, '..')
const webRoot = resolve(mobile, '..')
const assets = resolve(mobile, 'assets')

const { buildVersion } = await import(resolve(webRoot, 'scripts/build-version.mjs'))
const version = buildVersion()
execSync('npm run build', { cwd: webRoot, stdio: 'inherit', env: { ...process.env, VITE_BASE_PATH: '/', WIGGLE_BUILD_VERSION: version } })
execSync(`node scripts/pack-web-bundle.mjs dist "${assets}" --zip-name web.zip`, { cwd: webRoot, stdio: 'inherit', env: { ...process.env, WIGGLE_BUILD_VERSION: version } })
// The app reads its bundled version from web-manifest.json; the packer writes manifest.json.
renameSync(resolve(assets, 'manifest.json'), resolve(assets, 'web-manifest.json'))
const manifest = JSON.parse(readFileSync(resolve(assets, 'web-manifest.json'), 'utf8'))
console.log(`[sync-web] assets/web.zip ready, version ${manifest.version} (${manifest.files} files)`)
