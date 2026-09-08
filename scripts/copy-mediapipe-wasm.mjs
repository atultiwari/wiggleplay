// Copies the MediaPipe vision WASM runtime into public/ so the app can be
// hosted fully offline (no CDN dependency at runtime).
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const target = resolve(root, 'public/mediapipe/wasm')

if (!existsSync(source)) {
  console.error(`[copy-mediapipe-wasm] source not found: ${source}. Run npm install first.`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`[copy-mediapipe-wasm] copied wasm runtime to ${target}`)
