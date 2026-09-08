import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] })
const page = await browser.newPage()
await page.goto('http://localhost:5173/#/lab/bus?view=match&size=512&ground=0', { waitUntil: 'networkidle' })
await page.waitForFunction(() => document.querySelector('.lab')?.getAttribute('data-status') === 'ready', null, { timeout: 60000 })
const r = await page.evaluate(() => { const c = window.__IMG2THREEJS_CAPTURE__; c.setView('match'); return c.rigInfo() })
console.log('rig', JSON.stringify(r))
await browser.close()
