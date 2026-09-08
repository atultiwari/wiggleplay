/** Interaction-pass evidence: rotates the rig's bones and captures the posed model. */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const [modelId = 'mascot', outDir = `3d/${modelId}/renders`] = process.argv.slice(2)
const POSES = {
  'pose-wave': { 'arm-l': [0, 0, -0.9], 'arm-r': [0, 0, 0.9], 'hand-l': [0, 0, -0.5], 'hand-r': [0, 0, 0.5] },
  'pose-step': { 'foot-l': [0.6, 0, 0], 'foot-r': [-0.4, 0, 0], 'arm-l': [0, 0, 0.7], 'body': [0, 0.35, 0] },
}
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ viewport: { width: 1064, height: 1064 } })).newPage()
await page.goto(`${BASE_URL}/#/lab/${modelId}?view=hero&size=1024`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
const info = await page.evaluate(() => window.__IMG2THREEJS_CAPTURE__?.rigInfo())
const results = { rig: info, poses: {} }
for (const [name, rotations] of Object.entries(POSES)) {
  const r = await page.evaluate((rot) => window.__IMG2THREEJS_CAPTURE__?.pose(rot), rotations)
  await page.waitForTimeout(150)
  await page.locator('canvas.lab__canvas').screenshot({ path: `${outDir}/${name}.png` })
  results.poses[name] = r
  // reset
  await page.evaluate((rot) => window.__IMG2THREEJS_CAPTURE__?.pose(Object.fromEntries(Object.keys(rot).map((k) => [k, [0, 0, 0]]))), rotations)
}
writeFileSync(`3d/${modelId}/pose-test.json`, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
await browser.close()
