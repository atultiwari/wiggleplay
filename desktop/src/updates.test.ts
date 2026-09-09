import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { activeBundle, isNewerShell, Updater, type UpdateStatus } from './updates'

const makeBundleZip = (marker: string) => zipSync({ 'index.html': [new TextEncoder().encode(`<html>${marker}</html>`), { level: 0 }], 'assets/app.js': [new TextEncoder().encode('console.log(1)'), { level: 0 }] })

const body = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

const fakeServer = (manifest: object | null, zip: Uint8Array): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('manifest.json')) return manifest ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('', { status: 500 })
    return new Response(body(zip), { status: 200 })
  }) as typeof fetch

test('reports offline when the manifest cannot be fetched and keeps the current bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-upd-'))
  try {
    const store = { dir, bundledVersion: '20260901000000-aaa', bundledDir: join(dir, 'web') }
    const updater = new Updater({ store, shellVersion: '0.1.0', fetchImpl: fakeServer(null, new Uint8Array()) }, store.bundledVersion)
    const status = await updater.check()
    assert.equal(status.state, 'offline')
    assert.deepEqual(await activeBundle(store), { version: store.bundledVersion, dir: store.bundledDir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('downloads, verifies and unpacks a newer bundle, then serves it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-upd-'))
  try {
    const zip = makeBundleZip('new')
    const manifest = { version: '20260910120000-bbb', zip: 'https://example.test/updates/web.zip', bytes: zip.byteLength, sha256: createHash('sha256').update(zip).digest('hex'), notes: 'shiny', desktop: { version: '0.2.0', releases: 'https://example.test/releases' } }
    const store = { dir, bundledVersion: '20260901000000-aaa', bundledDir: join(dir, 'web') }
    await mkdir(store.bundledDir, { recursive: true })
    await writeFile(join(store.bundledDir, 'index.html'), 'old')
    const seen: UpdateStatus[] = []
    const updater = new Updater({ store, shellVersion: '0.1.0', fetchImpl: fakeServer(manifest, zip), onStatus: (s) => seen.push(s) }, store.bundledVersion)
    const available = await updater.check()
    assert.equal(available.state, 'available')
    assert.equal(available.latest, manifest.version)
    assert.equal(available.shellUpdateUrl, 'https://example.test/releases')
    const ready = await updater.download()
    assert.equal(ready.state, 'ready')
    assert.ok(seen.some((s) => s.state === 'downloading'))
    const active = await activeBundle(store)
    assert.equal(active.version, manifest.version)
    assert.equal(await readFile(join(active.dir, 'index.html'), 'utf8'), '<html>new</html>')
    // Checking again after the download keeps the ready state.
    assert.equal((await updater.check()).state, 'ready')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects a bundle whose hash does not match and stays on the old one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-upd-'))
  try {
    const zip = makeBundleZip('bad')
    const manifest = { version: '20260910120000-bbb', zip: 'https://example.test/updates/web.zip', bytes: zip.byteLength, sha256: 'deadbeef' }
    const store = { dir, bundledVersion: '20260901000000-aaa', bundledDir: join(dir, 'web') }
    const updater = new Updater({ store, shellVersion: '0.1.0', fetchImpl: fakeServer(manifest, zip) }, store.bundledVersion)
    await updater.check()
    const status = await updater.download()
    assert.equal(status.state, 'error')
    assert.match(status.message ?? '', /damaged/)
    assert.equal((await activeBundle(store)).version, store.bundledVersion)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('says up to date for an older or equal manifest and compares shell versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-upd-'))
  try {
    const store = { dir, bundledVersion: '20260910000000-aaa', bundledDir: join(dir, 'web') }
    const manifest = { version: '20260909000000-old', zip: 'https://example.test/w.zip', bytes: 1, sha256: 'x', desktop: { version: '0.1.0', releases: 'r' } }
    const updater = new Updater({ store, shellVersion: '0.1.0', fetchImpl: fakeServer(manifest, new Uint8Array()) }, store.bundledVersion)
    const status = await updater.check()
    assert.equal(status.state, 'up-to-date')
    assert.equal(status.shellUpdateUrl, undefined)
    assert.equal(isNewerShell('0.2.0', '0.1.9'), true)
    assert.equal(isNewerShell('0.1.0', '0.1.0'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
