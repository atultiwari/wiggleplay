import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromBase64, toBase64 } from './base64.ts'

test('round-trips bytes of every length remainder and matches Buffer', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 300, 65537]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) % 256)
    const encoded = toBase64(bytes)
    assert.equal(encoded, Buffer.from(bytes).toString('base64'))
    assert.deepEqual(Array.from(fromBase64(encoded)), Array.from(bytes))
  }
})
