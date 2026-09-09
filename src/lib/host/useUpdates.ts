import { useEffect, useState } from 'react'
import type { HostBridge, UpdateStatus } from './types'

declare global {
  interface Window {
    wigglePlayHost?: HostBridge
  }
}

/** Version baked in at build time (scripts/pack-web-bundle.mjs uses the same stamp). */
export const BUILD_VERSION: string = typeof __WIGGLE_BUILD__ === 'string' ? __WIGGLE_BUILD__ : 'dev'

export const getHost = (): HostBridge | null => (typeof window !== 'undefined' && window.wigglePlayHost ? window.wigglePlayHost : null)

const WEBSITE_STATUS: UpdateStatus = { state: 'up-to-date', current: BUILD_VERSION }

/** Live update status from the shell, or a static "website" status when there is no shell. */
export const useUpdates = (): { readonly host: HostBridge | null; readonly status: UpdateStatus; readonly busy: boolean; readonly check: () => void; readonly download: () => void; readonly apply: () => void } => {
  const [host] = useState<HostBridge | null>(getHost)
  const [status, setStatus] = useState<UpdateStatus>(WEBSITE_STATUS)

  useEffect(() => {
    if (!host) return
    let active = true
    host.getStatus().then((s) => active && setStatus(s)).catch(() => undefined)
    const off = host.onStatus((s) => active && setStatus(s))
    return () => {
      active = false
      off()
    }
  }, [host])

  const guard = (run: () => Promise<unknown>) => () => {
    run().catch((error: unknown) => setStatus((s) => ({ ...s, state: 'error', message: error instanceof Error ? error.message : 'Something went wrong.' })))
  }
  return {
    host,
    status,
    busy: status.state === 'checking' || status.state === 'downloading',
    check: guard(() => host?.checkForUpdates() ?? Promise.resolve()),
    download: guard(() => host?.downloadUpdate() ?? Promise.resolve()),
    apply: guard(() => host?.applyUpdate() ?? Promise.resolve()),
  }
}
