// Exercises the in-app content update flow against a local update server:
// check → download → verify → relaunch with the new bundle. Run after `npm run build`.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = resolve(import.meta.dirname, '..')
const NEW_VERSION = '99991231235959-e2etest'
const work = mkdtempSync(join(tmpdir(), 'wp-update-'))
const serverDir = join(work, 'server')
const updateDir = join(work, 'updates')

// Serve a copy of the built web app as a "newer" bundle.
const server = createServer((req, res) => {
  const file = join(serverDir, new URL(req.url, 'http://x').pathname.replace(/^\/updates\//, '/'))
  if (!existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/zip' }).end(readFileSync(file))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}/`
execFileSync('node', [resolve(desktop, '../scripts/pack-web-bundle.mjs'), join(desktop, 'web'), serverDir, '--site', origin], { env: { ...process.env, WIGGLE_BUILD_VERSION: NEW_VERSION }, stdio: 'inherit' })

const env = {
  ...process.env,
  WIGGLEPLAY_FAKE_CAMERA: '1',
  WIGGLEPLAY_ASSET_DIR: join(work, 'assets'),
  WIGGLEPLAY_UPDATE_DIR: updateDir,
  WIGGLEPLAY_MANIFEST_URL: `${origin}manifest.json`,
  WIGGLEPLAY_SKIP_UPDATE_CHECK: '1',
}
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.waitForURL(/wiggleplay:\/\/app\/index\.html/, { timeout: 30_000 })
  await page.waitForSelector('[data-testid^="game-card-"]', { timeout: 30_000 })
  return { app, page }
}

const first = await launch()
const before = await first.page.evaluate(() => window.wigglePlayDesktop.info())
console.log(`running bundle ${before.bundle}`)
await first.page.getByRole('button', { name: 'Open settings' }).click()
const section = first.page.getByRole('region', { name: 'Updates' })
await section.getByRole('button', { name: 'Check for updates' }).click()
await section.getByText('New games are ready to download').waitFor({ timeout: 15_000 })
await first.page.locator('.settings-button__badge').waitFor({ timeout: 5_000 })
await section.getByRole('button', { name: /Download the new games/ }).click()
await section.getByText('Downloaded! Restart').waitFor({ timeout: 120_000 })
const current = JSON.parse(readFileSync(join(updateDir, 'current.json'), 'utf8'))
console.log(`downloaded bundle ${current.version} into ${current.dir}`)
await first.app.close()

const second = await launch()
const after = await second.page.evaluate(() => window.wigglePlayDesktop.info())
await second.page.getByRole('button', { name: 'Open settings' }).click()
await second.page.getByRole('region', { name: 'Updates' }).getByRole('button', { name: 'Check for updates' }).click()
await second.page.getByRole('region', { name: 'Updates' }).getByText('You have the newest games').waitFor({ timeout: 15_000 })
await second.app.close()
server.close()
if (after.bundle !== NEW_VERSION || current.version !== NEW_VERSION || !existsSync(join(current.dir, 'index.html'))) {
  console.error('update e2e failed', { before: before.bundle, after: after.bundle, current })
  process.exit(1)
}
console.log(`update e2e passed: ${before.bundle} → ${after.bundle}`)
