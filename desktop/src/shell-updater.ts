import { autoUpdater } from 'electron-updater'

/**
 * Updates the installer itself (Windows NSIS only; macOS needs a signed app for that, so Mac
 * parents get a download link instead). Never downloads without the parent pressing the button.
 */
export class ShellUpdater {
  private available = false
  private downloaded = false

  constructor(private readonly enabled: boolean) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('update-available', () => {
      this.available = true
    })
    autoUpdater.on('update-downloaded', () => {
      this.downloaded = true
    })
    autoUpdater.on('error', () => {
      this.available = false
    })
  }

  private get active(): boolean {
    return this.enabled && process.platform === 'win32'
  }

  async checkQuietly(): Promise<void> {
    if (!this.active) return
    await autoUpdater.checkForUpdates().catch(() => null)
  }

  /** Called when the parent presses the "new app version" button; returns true when handled here. */
  async installIfDownloaded(): Promise<boolean> {
    if (!this.active || !this.available) return false
    if (!this.downloaded) {
      await autoUpdater.downloadUpdate()
      return true
    }
    autoUpdater.quitAndInstall()
    return true
  }
}
