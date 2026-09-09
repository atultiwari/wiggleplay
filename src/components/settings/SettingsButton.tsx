import { useState } from 'react'
import { useUpdates } from '../../lib/host/useUpdates'
import { SettingsPanel } from './SettingsPanel'

/** Plain-click gear for grown-up pages (the hub, the parents page). */
export const SettingsButton = ({ className = '' }: { readonly className?: string }) => {
  const [open, setOpen] = useState(false)
  const { status } = useUpdates()
  const updateReady = status.state === 'ready' || status.state === 'available'
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-label="Open settings" title="Settings">
        ⚙️ <span className="settings-button__label">Settings</span>
        {updateReady && <span className="settings-button__badge" aria-label="New games available" />}
      </button>
      {open && <SettingsPanel onClose={() => setOpen(false)} />}
    </>
  )
}
