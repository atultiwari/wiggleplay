import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
const logs = []
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message))
page.on('console', (m) => logs.push(`${m.type()} ${m.text()}`))
await page.goto('http://localhost:5173/#/lab/mascot?view=front&size=512', { waitUntil: 'networkidle' })
await page.waitForTimeout(8000)
const state = await page.evaluate(() => ({ ready: window.__IMG2THREEJS_READY__, status: document.querySelector('.lab')?.getAttribute('data-status'), text: document.querySelector('.lab__message')?.textContent, gl: !!document.createElement('canvas').getContext('webgl2') }))
console.log(JSON.stringify(state))
logs.slice(0, 25).forEach((l) => console.log(l.slice(0, 400)))
await browser.close()
