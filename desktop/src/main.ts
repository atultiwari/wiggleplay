import { app, BrowserWindow, ipcMain, net, protocol, session, shell, systemPreferences } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureAssets, findAsset, RUNTIME_ASSETS, type AssetProgress } from './assets'
import { ShellUpdater } from './shell-updater'
import { activeBundle, Updater, type BundleStore, type UpdateStatus } from './updates'

/** The app is served from its own scheme so it is a secure context (camera, WASM, fetch all work offline). */
const SCHEME = 'wiggleplay'
const APP_HOST = 'app'
const WEB_DIR = join(__dirname, '..', 'web')
const SETUP_PAGE = join(__dirname, '..', 'setup', 'index.html')
/** The games site also publishes content updates (updates/manifest.json); nothing else may be reached. */
const UPDATE_ORIGINS = ['https://atultiwari.github.io/', 'https://github.com/', 'https://objects.githubusercontent.com/', 'https://release-assets.githubusercontent.com/']
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

const assetDir = () => process.env.WIGGLEPLAY_ASSET_DIR ?? join(app.getPath('userData'), 'runtime-assets')

/** Version stamp written by scripts/build-web.mjs next to the bundled web app. */
const bundledVersion = (): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(WEB_DIR, 'version.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') return (parsed as { version: string }).version
  } catch {
    /* development build without a stamp */
  }
  return '00000000000000-bundled'
}
const bundleStore = (): BundleStore => ({ dir: process.env.WIGGLEPLAY_UPDATE_DIR ?? join(app.getPath('userData'), 'updates'), bundledVersion: bundledVersion(), bundledDir: WEB_DIR })

/** Set once at boot: the newest downloaded games bundle, or the built-in one. */
let webDir = WEB_DIR
const searchDirs = () => [assetDir(), webDir, WEB_DIR]

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

if (process.env.WIGGLEPLAY_FAKE_CAMERA === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const mimeFor = (file: string): string => MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'

/** Serves the bundled web build; the tracking runtime files may come from the user's download folder instead. */
const serveApp = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const runtime = RUNTIME_ASSETS.find((asset) => asset.path === relative)
  const file = runtime ? await findAsset(runtime, searchDirs()) : join(webDir, relative)
  if (!file || !existsSync(file)) return new Response('Not found', { status: 404 })
  const response = await net.fetch(pathToFileURL(file).toString())
  return new Response(response.body, { status: 200, headers: { 'content-type': mimeFor(file), 'cache-control': 'no-cache' } })
}

/** The app is fully self-contained: no request may leave it (this also drops MediaPipe's telemetry ping). */
const blockNetwork = () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    // Only the main process (asset setup, installer updates) may talk to the update hosts; the games page never does.
    const fromMain = details.webContentsId === undefined
    const origins = process.env.WIGGLEPLAY_ASSET_ORIGIN ? [...UPDATE_ORIGINS, process.env.WIGGLEPLAY_ASSET_ORIGIN] : UPDATE_ORIGINS
    callback({ cancel: !(fromMain && origins.some((origin) => details.url.startsWith(origin))) })
  })
}

const allowMedia = () => {
  const ok = new Set(['media', 'mediaKeySystem', 'fullscreen', 'speaker-selection', 'display-capture'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ok.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ok.has(permission))
}

const askSystemMediaAccess = async () => {
  if (process.platform !== 'darwin') return
  for (const kind of ['camera', 'microphone'] as const) {
    if (systemPreferences.getMediaAccessStatus(kind) !== 'granted') await systemPreferences.askForMediaAccess(kind).catch(() => false)
  }
}

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: 'WigglePlay',
    backgroundColor: '#1b1533',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  return win
}

const runSetup = async (win: BrowserWindow): Promise<boolean> => {
  await win.loadFile(SETUP_PAGE)
  const report = (progress: AssetProgress | { readonly error: string } | { readonly done: true }) => {
    if (!win.isDestroyed()) win.webContents.send('setup:progress', progress)
  }
  try {
    await ensureAssets({ searchDirs: searchDirs(), downloadDir: assetDir(), origin: process.env.WIGGLEPLAY_ASSET_ORIGIN, onProgress: report })
    report({ done: true })
    return true
  } catch (error) {
    report({ error: error instanceof Error ? error.message : 'The download failed.' })
    return false
  }
}

/** Content updates: checked quietly at start, downloaded only when a parent asks, applied by relaunching. */
const wireUpdates = (win: BrowserWindow, current: string): Updater => {
  const shell = new ShellUpdater(app.isPackaged)
  const send = (status: UpdateStatus) => {
    if (!win.isDestroyed()) win.webContents.send('updates:status', status)
  }
  const updater = new Updater({ store: bundleStore(), shellVersion: app.getVersion(), manifestUrl: process.env.WIGGLEPLAY_MANIFEST_URL, onStatus: send }, current)
  ipcMain.handle('updates:status', () => updater.getStatus())
  ipcMain.handle('updates:check', () => updater.check())
  ipcMain.handle('updates:download', () => updater.download())
  ipcMain.handle('updates:apply', () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('updates:open', async (_event, url: unknown) => {
    if (await shell.installIfDownloaded()) return
    if (typeof url === 'string' && UPDATE_ORIGINS.some((origin) => url.startsWith(origin))) await shell_openExternal(url)
  })
  shell.checkQuietly().catch(() => undefined)
  return updater
}
const shell_openExternal = (url: string) => shell.openExternal(url)

const boot = async () => {
  protocol.handle(SCHEME, serveApp)
  blockNetwork()
  allowMedia()
  const active = await activeBundle(bundleStore())
  webDir = active.dir
  const win = createWindow()
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion()
  })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, assetDir: assetDir(), bundle: active.version }))
  const updater = wireUpdates(win, active.version)
  ipcMain.handle('setup:retry', async () => {
    if (await runSetup(win)) await win.loadURL(`${SCHEME}://${APP_HOST}/index.html`)
  })
  const ready = await runSetup(win)
  if (!ready) return
  await askSystemMediaAccess()
  await win.loadURL(`${SCHEME}://${APP_HOST}/index.html`)
  if (process.env.WIGGLEPLAY_SKIP_UPDATE_CHECK !== '1') setTimeout(() => updater.check().catch(() => undefined), 4000)
}

app.whenReady().then(boot).catch((error) => {
  console.error('[wiggleplay] failed to start', error)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot().catch(console.error)
})
