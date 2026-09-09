import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureAssets, findAsset, missingAssets, RUNTIME_ASSETS, type AssetProgress } from './assets'

const fakeFetch = (bytesPerFile: number, calls: string[]): typeof fetch =>
  (async (input: string | URL | Request) => {
    calls.push(String(input))
    const body = new Uint8Array(bytesPerFile)
    return new Response(body, { status: 200, headers: { 'content-length': String(bytesPerFile) } })
  }) as typeof fetch

test('a bundled copy that is large enough is found and nothing is downloaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-assets-'))
  try {
    for (const asset of RUNTIME_ASSETS) {
      await mkdir(join(dir, 'bundled', asset.path, '..'), { recursive: true })
      await writeFile(join(dir, 'bundled', asset.path), Buffer.alloc(asset.minBytes))
    }
    const calls: string[] = []
    const downloaded = await ensureAssets({ searchDirs: [join(dir, 'user'), join(dir, 'bundled')], downloadDir: join(dir, 'user'), fetchImpl: fakeFetch(1, calls) })
    assert.equal(downloaded.length, 0)
    assert.equal(calls.length, 0)
    assert.equal(await findAsset(RUNTIME_ASSETS[0], [join(dir, 'user'), join(dir, 'bundled')]), join(dir, 'bundled', RUNTIME_ASSETS[0].path))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing or too-small files are downloaded with progress and then verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-assets-'))
  try {
    // One damaged (too small) bundled file, everything else absent.
    const damaged = RUNTIME_ASSETS[0]
    await mkdir(join(dir, 'bundled', damaged.path, '..'), { recursive: true })
    await writeFile(join(dir, 'bundled', damaged.path), Buffer.alloc(10))
    const calls: string[] = []
    const progress: AssetProgress[] = []
    const bigEnough = Math.max(...RUNTIME_ASSETS.map((a) => a.minBytes))
    const missingBefore = await missingAssets({ searchDirs: [join(dir, 'bundled')], downloadDir: join(dir, 'user') })
    assert.equal(missingBefore.length, RUNTIME_ASSETS.length)
    const downloaded = await ensureAssets({
      searchDirs: [join(dir, 'user'), join(dir, 'bundled')],
      downloadDir: join(dir, 'user'),
      origin: 'https://example.test/app/',
      fetchImpl: fakeFetch(bigEnough, calls),
      onProgress: (p) => progress.push(p),
    })
    assert.equal(downloaded.length, RUNTIME_ASSETS.length)
    assert.ok(calls[0].startsWith('https://example.test/app/mediapipe/wasm/'))
    assert.ok(progress.some((p) => p.receivedBytes === bigEnough && p.totalBytes === bigEnough))
    const written = await readFile(join(dir, 'user', damaged.path))
    assert.equal(written.byteLength, bigEnough)
    const missingAfter = await missingAssets({ searchDirs: [join(dir, 'user'), join(dir, 'bundled')], downloadDir: join(dir, 'user') })
    assert.equal(missingAfter.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a short download is rejected and leaves no half file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-assets-'))
  try {
    const calls: string[] = []
    await assert.rejects(ensureAssets({ searchDirs: [], downloadDir: join(dir, 'user'), fetchImpl: fakeFetch(5, calls) }), /incomplete/)
    const missing = await missingAssets({ searchDirs: [join(dir, 'user')], downloadDir: join(dir, 'user') })
    assert.equal(missing.length, RUNTIME_ASSETS.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
