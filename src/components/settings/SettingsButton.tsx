import { useState } from 'react'
import { SettingsPanel } from './SettingsPanel'

/** Plain-click gear for grown-up pages (the hub, the parents page). */
export const SettingsButton = ({ className = '' }: { readonly className?: string }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-label="Open settings" title="Settings">
        ⚙️ <span className="settings-button__label">Settings</span>
      </button>
      {open && <SettingsPanel onClose={() => setOpen(false)} />}
    </>
  )
}
