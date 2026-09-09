/**
 * Smoke test: launches the locally installed Chrome with a fake camera and
 * walks every ready game from the intro overlay into the "playing" phase.
 * Usage: npm run dev (in another terminal) then `npm run e2e:smoke`.
 *   BASE_URL=http://localhost:4173 npm run e2e:smoke   # against `npm run preview`
 *   HEADED=1 npm run e2e:smoke                          # watch it happen
 */
import { chromium } from 'playwright-core'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const GAMES = (process.env.GAMES ? process.env.GAMES.split(',') : ['air-paint', 'catch-stars', 'wave-pop', 'fruit-slice', 'cat-tickle', 'fly-high', 'bus-driver', 'beep-meow-whoosh', 'wiggle-mirror', 'toy-town', 'simon-says', 'tap-farm', 'animal-call', 'shake-tree', 'alphabet-trail', 'path-tracer'])
const PLAYING_TIMEOUT_MS = 60_000

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !process.env.HEADED,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  const failures = []
  for (const id of GAMES) {
    const startedAt = Date.now()
    try {
      await page.goto(`${BASE_URL}/#/play/${id}`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '▶ Play' }).click()
      await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: PLAYING_TIMEOUT_MS })
      await page.waitForTimeout(2500)
      const info = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        const video = document.querySelector('video')
        return {
          canvas: canvas ? `${canvas.width}x${canvas.height}` : 'missing',
          videoReady: video ? video.readyState : -1,
          hud: document.querySelector('.hud')?.textContent ?? '',
          hint: document.querySelector('.shell__hint')?.textContent ?? '',
        }
      })
      await page.screenshot({ path: `e2e/screenshots/${id}.png` })
      console.log(`✅ ${id} reached playing in ${Date.now() - startedAt}ms`, info)
    } catch (error) {
      failures.push(id)
      await page.screenshot({ path: `e2e/screenshots/${id}-failed.png` }).catch(() => {})
      const overlay = await page.evaluate(() => document.querySelector('.overlay')?.innerText ?? '').catch(() => '')
      console.error(`❌ ${id} failed: ${error instanceof Error ? error.message : error}\n   overlay: ${overlay.replace(/\n+/g, ' | ')}`)
    }
  }

  await browser.close()
  if (consoleErrors.length > 0) {
    console.log('\nConsole errors seen:')
    consoleErrors.forEach((line) => console.log('  -', line))
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} game(s) failed: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nAll games reached the playing phase.')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
