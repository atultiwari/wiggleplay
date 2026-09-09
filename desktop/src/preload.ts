import { contextBridge, ipcRenderer } from 'electron'

/** The setup page gets download progress; the games get the update bridge (`window.wigglePlayHost`). */
contextBridge.exposeInMainWorld('wigglePlayDesktop', {
  info: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string; assetDir: string; bundle: string }>,
  retrySetup: () => ipcRenderer.invoke('setup:retry') as Promise<void>,
  onSetupProgress: (listener: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => listener(progress)
    ipcRenderer.on('setup:progress', handler)
    return () => ipcRenderer.removeListener('setup:progress', handler)
  },
})

contextBridge.exposeInMainWorld('wigglePlayHost', {
  kind: 'desktop',
  appVersion: ipcRenderer.sendSync('app:version') as string,
  getStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  applyUpdate: () => ipcRenderer.invoke('updates:apply'),
  onStatus: (listener: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => listener(status)
    ipcRenderer.on('updates:status', handler)
    return () => ipcRenderer.removeListener('updates:status', handler)
  },
  openExternal: (url: string) => {
    ipcRenderer.invoke('updates:open', url).catch(() => undefined)
  },
})
