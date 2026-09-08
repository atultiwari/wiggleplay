/** Exports world-space mesh geometry of a lab model to JSON for the img2threejs geometry gates. */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const [modelId = 'mascot', out = `3d/${modelId}/meshes.json`] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.goto(`${BASE_URL}/#/lab/${modelId}?view=front&size=256`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
const data = await page.evaluate(() => window.__IMG2THREEJS_CAPTURE__?.exportMeshes())
writeFileSync(out, JSON.stringify(data))
console.log(`wrote ${out}: ${data.meshes.length} meshes, ${data.meshes.reduce((n, m) => n + m.vertices.length, 0)} vertices`)
await browser.close()
