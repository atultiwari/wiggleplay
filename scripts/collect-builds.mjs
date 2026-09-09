// Copies every installable build into builds/ with clear names so the right file is easy to pick.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'builds')
mkdirSync(out, { recursive: true })
const version = '0.1.0'
const wanted = [
  [join(root, 'desktop/release', `WigglePlay-${version}-arm64.dmg`), `WigglePlay-${version}-macOS-AppleSilicon.dmg`],
  [join(root, 'desktop/release', `WigglePlay-${version}.dmg`), `WigglePlay-${version}-macOS-Intel.dmg`],
  [join(root, 'desktop/release', `WigglePlay Setup ${version}.exe`), `WigglePlay-${version}-Windows-Setup.exe`],
  [join(root, 'desktop/release', `WigglePlay ${version}.exe`), `WigglePlay-${version}-Windows-Portable.exe`],
  [join(root, 'mobile/android/app/build/outputs/apk/release/app-release.apk'), `WigglePlay-${version}-Android.apk`],
]
for (const [from, name] of wanted) {
  if (!existsSync(from)) {
    console.log(`skip (not built): ${name}`)
    continue
  }
  copyFileSync(from, join(out, name))
  console.log(`copied ${name}`)
}
console.log(`\nbuilds in ${out}:`, readdirSync(out).join(', '))
