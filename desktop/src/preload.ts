import { contextBridge, ipcRenderer } from 'electron'

/** A tiny bridge: the web app can tell it is running on the desktop, and the setup page gets progress. */
contextBridge.exposeInMainWorld('wigglePlayDesktop', {
  info: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string; assetDir: string }>,
  retrySetup: () => ipcRenderer.invoke('setup:retry') as Promise<void>,
  onSetupProgress: (listener: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => listener(progress)
    ipcRenderer.on('setup:progress', handler)
    return () => ipcRenderer.removeListener('setup:progress', handler)
  },
})
