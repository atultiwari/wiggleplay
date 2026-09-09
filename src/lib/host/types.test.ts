import { describe, expect, it } from 'vitest'
import { isNewerVersion, isUpdateManifest, versionStamp } from './types'

describe('update versions', () => {
  it('orders bundle versions by their date stamp', () => {
    expect(versionStamp('20260909041536-b0f8c41')).toBe(20260909041536)
    expect(versionStamp('dev')).toBe(0)
    expect(isNewerVersion('20260910000000-abc', '20260909041536-b0f8c41')).toBe(true)
    expect(isNewerVersion('20260909041536-b0f8c41', '20260909041536-zzz')).toBe(false)
    expect(isNewerVersion('20260909041536-b0f8c41', 'dev')).toBe(true)
  })

  it('accepts only complete manifests', () => {
    expect(isUpdateManifest({ version: '1', zip: 'https://x/web.zip', sha256: 'ab', bytes: 3, files: 1 })).toBe(true)
    expect(isUpdateManifest({ version: '1', zip: 'https://x/web.zip' })).toBe(false)
    expect(isUpdateManifest(null)).toBe(false)
  })
})
