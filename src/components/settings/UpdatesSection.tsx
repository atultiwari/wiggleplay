import { useUpdates } from '../../lib/host/useUpdates'
import type { UpdateStatus } from '../../lib/host/types'

const KIND_LABEL = { desktop: 'Desktop app', android: 'Android app', ios: 'iPhone / iPad app' } as const

const shortVersion = (version: string): string => {
  const m = version.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}-(\w+)$/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} (${m[6]})` : version
}

const describe = (status: UpdateStatus): string => {
  switch (status.state) {
    case 'checking':
      return 'Checking for new games…'
    case 'up-to-date':
      return 'You have the newest games.'
    case 'available':
      return `New games are ready to download${status.bytes ? ` (${(status.bytes / 1048576).toFixed(0)} MB)` : ''}.`
    case 'downloading':
      return `Downloading… ${Math.round((status.progress ?? 0) * 100)}%`
    case 'ready':
      return 'Downloaded! Restart to start playing the new games.'
    case 'offline':
      return 'No internet right now. The games work offline; check again when you are connected.'
    case 'error':
      return status.message ?? 'The update did not work. Try again later.'
    default:
      return 'Updates are checked each time the app starts.'
  }
}

/** Parent-only update controls: nothing here ever interrupts the child during play. */
export const UpdatesSection = () => {
  const { host, status, busy, check, download, apply } = useUpdates()
  return (
    <section className="settings__section" aria-label="Updates">
      <div className="settings__section-head">
        <h3>🔄 Updates</h3>
      </div>
      {host ? (
        <>
          <p className="settings__hint">
            {KIND_LABEL[host.kind]} {host.appVersion} · games bundle {shortVersion(status.current)}
            {status.latest && status.latest !== status.current ? ` → ${shortVersion(status.latest)}` : ''}
          </p>
          <p className="settings__hint" role="status" aria-live="polite">
            {describe(status)}
          </p>
          {status.state === 'downloading' && (
            <progress className="settings__progress" value={Math.round((status.progress ?? 0) * 100)} max={100} />
          )}
          {status.notes && status.state !== 'up-to-date' && <p className="settings__hint">What is new: {status.notes}</p>}
          <div className="settings__actions">
            {status.state === 'available' ? (
              <button type="button" className="btn" onClick={download} disabled={busy}>
                ⬇️ Download the new games
              </button>
            ) : status.state === 'ready' ? (
              <button type="button" className="btn" onClick={apply}>
                🔁 Restart now
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={check} disabled={busy}>
                Check for updates
              </button>
            )}
            {status.shellUpdateUrl && (
              <button type="button" className="btn btn--ghost" onClick={() => host.openExternal?.(status.shellUpdateUrl ?? '')}>
                New app version: open download page
              </button>
            )}
          </div>
          <p className="settings__hint">Updates only download when you press the button, so nothing uses mobile data by surprise. Everything keeps working offline in between.</p>
        </>
      ) : (
        <p className="settings__hint">You are playing on the website (build {shortVersion(status.current)}). It always has the newest games: just reload the page.</p>
      )}
    </section>
  )
}
