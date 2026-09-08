/** Interaction-pass evidence for props: rotates named pivot nodes and captures the result. */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const [modelId = 'bus', outDir = `3d/${modelId}/renders`, posesJson] = process.argv.slice(2)
const POSES = posesJson ? JSON.parse(posesJson) : { 'pivot-wheels': { 'wheel-rear-near': [0, 0, 0.9], 'wheel-front-near': [0, 0, 0.9], 'wheel-rear-far': [0, 0, 0.9], 'wheel-front-far': [0, 0, 0.9] }, 'pivot-door': { door: [0, -1.2, 0] } }
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ viewport: { width: 1064, height: 1064 } })).newPage()
await page.goto(`${BASE_URL}/#/lab/${modelId}?view=hero&size=1024`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
const results = {}
for (const [name, rotations] of Object.entries(POSES)) {
  const rest = await page.evaluate((rot) => window.__IMG2THREEJS_CAPTURE__?.pivots(Object.fromEntries(Object.keys(rot).map((k) => [k, [0, 0, 0]]))), rotations)
  const posed = await page.evaluate((rot) => window.__IMG2THREEJS_CAPTURE__?.pivots(rot), rotations)
  results[name] = { ...posed, restRimPoints: rest?.rimPoints }
  await page.waitForTimeout(150)
  await page.locator('canvas.lab__canvas').screenshot({ path: `${outDir}/${name}.png` })
  await page.evaluate((rot) => window.__IMG2THREEJS_CAPTURE__?.pivots(Object.fromEntries(Object.keys(rot).map((k) => [k, [0, 0, 0]]))), rotations)
}
writeFileSync(`3d/${modelId}/pivot-test.json`, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
await browser.close()
