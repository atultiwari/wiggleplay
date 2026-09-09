// Builds the web app with a root base path and copies it into desktop/web.
// `--lite` leaves out the MediaPipe runtime and models so the installer is small;
// the app then downloads them on first start (see src/assets.ts).
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVersion } from '../../scripts/build-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const webRoot = resolve(desktop, '..')
const lite = process.argv.includes('--lite')

const version = buildVersion()
execSync('npm run build', { cwd: webRoot, stdio: 'inherit', env: { ...process.env, VITE_BASE_PATH: '/', WIGGLE_BUILD_VERSION: version } })

const target = resolve(desktop, 'web')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(resolve(webRoot, 'dist'), target, {
  recursive: true,
  filter: (source) => !(lite && (source.includes('/mediapipe/') || source.includes('/models/'))),
})
writeFileSync(resolve(target, 'version.json'), JSON.stringify({ version }))
mkdirSync(resolve(desktop, 'build'), { recursive: true })
cpSync(resolve(webRoot, 'public/icon-512.png'), resolve(desktop, 'build/icon.png'))
console.log(`[build-web] copied web build ${version} to ${target}${lite ? ' (lite: runtime assets download on first start)' : ''}`)
if (!existsSync(resolve(target, 'index.html'))) throw new Error('index.html missing from the web build')
