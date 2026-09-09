// Launches the packaged-in-place Electron app with a fake camera, waits for the hub, opens a camera
// game and a touch game, and checks the tracking runtime was served from the app itself (offline).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const assetDir = mkdtempSync(join(tmpdir(), 'wp-desktop-'))
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, WIGGLEPLAY_FAKE_CAMERA: '1', WIGGLEPLAY_ASSET_DIR: assetDir, WIGGLEPLAY_ASSET_ORIGIN: 'http://127.0.0.1:9/' },
})
const requests = []
app.on('window', (page) => page.on('requestfinished', (request) => requests.push(request.url())))
const page = await app.firstWindow()
await page.waitForURL(/wiggleplay:\/\/app\/index\.html/, { timeout: 30_000 })
await page.waitForSelector('[data-testid^="game-card-"]', { timeout: 30_000 })
const cards = await page.locator('[data-testid^="game-card-"]').count()
console.log(`hub loaded with ${cards} game cards, url ${page.url()}`)

const failures = []
for (const id of ['wave-pop', 'tap-farm']) {
  await page.goto(`wiggleplay://app/index.html#/play/${id}`)
  await page.getByRole('button', { name: '▶ Play' }).click()
  try {
    await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    const hud = await page.evaluate(() => document.querySelector('.hud')?.textContent ?? '')
    console.log(`✅ ${id} reached playing (hud: ${hud})`)
  } catch (error) {
    failures.push(id)
    const overlay = await page.evaluate(() => document.querySelector('.overlay')?.innerText ?? '').catch(() => '')
    console.error(`❌ ${id}: ${error instanceof Error ? error.message : error} | overlay: ${overlay.replace(/\n+/g, ' | ')}`)
  }
}
const screenshot = join(assetDir, 'desktop-smoke.png')
await page.screenshot({ path: screenshot })
const external = requests.filter((url) => url.startsWith('http'))   // finished requests only: blocked ones never complete
const local = requests.filter((url) => url.includes('mediapipe/wasm') || url.includes('models/'))
console.log(`runtime requests served by the app: ${local.length}; external network requests: ${external.length}`)
writeFileSync(join(assetDir, 'requests.json'), JSON.stringify(requests, null, 2))
await app.close()
if (failures.length > 0 || external.length > 0 || local.length === 0) {
  console.error('desktop smoke failed', { failures, external })
  process.exit(1)
}
console.log(`desktop smoke passed; screenshot at ${screenshot}`)
