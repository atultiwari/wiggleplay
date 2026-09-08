/** Exports the built part tree of a lab model for img2threejs's part-coverage gate. */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const [modelId = 'mascot', out = `3d/${modelId}/parts.json`] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.goto(`${BASE_URL}/#/lab/${modelId}?view=front&size=256`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
const data = await page.evaluate(() => window.__IMG2THREEJS_CAPTURE__?.exportParts())
writeFileSync(out, JSON.stringify(data, null, 2))
console.log(`wrote ${out}: ${data.parts.length} parts, ${data.unnamedMeshes} unnamed, ${data.parts.reduce((n, p) => n + p.triangles, 0)} triangles`)
await browser.close()
