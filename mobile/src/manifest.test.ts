import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hexOf, isManifest, isNewerVersion, statusFor } from './manifest.ts'

test('manifest helpers', () => {
  assert.equal(isNewerVersion('20260910000000-b', '20260909000000-a'), true)
  assert.equal(isNewerVersion('20260909000000-a', '20260909000000-a'), false)
  assert.equal(isManifest({ version: '1', zip: 'u', sha256: 's', bytes: 1 }), true)
  assert.equal(isManifest({ version: '1' }), false)
  assert.equal(hexOf(new Uint8Array([0, 255, 16]).buffer), '00ff10')
  const manifest = { version: '20260910000000-b', zip: 'u', sha256: 's', bytes: 5, notes: 'n' }
  assert.equal(statusFor(manifest, '20260909000000-a', { state: 'idle', current: '20260909000000-a' }).state, 'available')
  assert.equal(statusFor(manifest, '20260910000000-b', { state: 'idle', current: '20260910000000-b' }).state, 'up-to-date')
  const ready = { state: 'ready' as const, current: '20260909000000-a', latest: manifest.version }
  assert.equal(statusFor(manifest, '20260909000000-a', ready), ready)
})
