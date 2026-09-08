/**
 * Captures deterministic review renders of a lab model for img2threejs gates.
 * Usage: node e2e/lab-capture.mjs <modelId> <outDir> [view,view,...]
 * Needs the dev server on BASE_URL (default http://localhost:5173).
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const [modelId = 'mascot', outDir = `3d/${modelId}/renders`, viewsArg] = process.argv.slice(2)
const views = (viewsArg ?? 'match,front,hero,right,rear,left,orbit-plus,orbit-minus,rear-quarter,head,head-quarter').split(',')
const size = Number(process.env.SIZE ?? 1024)

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ viewport: { width: size + 40, height: size + 40 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

for (const view of views) {
  const url = `${BASE_URL}/#/lab/${modelId}?view=${encodeURIComponent(view)}&size=${size}${process.env.GROUND === '0' ? '&ground=0' : ''}${process.env.UNLIT === '1' ? '&unlit=1' : ''}${process.env.BG ? `&bg=${encodeURIComponent(process.env.BG)}` : ''}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__IMG2THREEJS_READY__ === true && document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__IMG2THREEJS_CAPTURE__?.setView(new URLSearchParams(location.hash.split('?')[1]).get('view') ?? 'front'))
  await page.waitForTimeout(200)
  const path = `${outDir}/${view}${process.env.UNLIT === '1' ? '-unlit' : ''}.png`
  await page.locator('canvas.lab__canvas').screenshot({ path })
  console.log(`captured ${path}`)
}
if (errors.length) {
  console.log('console errors:')
  errors.forEach((e) => console.log('  -', e))
}
await browser.close()
