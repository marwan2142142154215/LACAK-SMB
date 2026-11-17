'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Jembatan aman renderer <-> main (contextIsolation). Renderer tidak punya akses
 * Node; hanya fungsi di bawah ini.
 */
contextBridge.exposeInMainWorld('agent', {
    login: (creds) => ipcRenderer.invoke('login', creds),
    verifyTwoFactor: (payload) => ipcRenderer.invoke('verify2fa', payload),
    reportFix: (fix) => ipcRenderer.send('geo:fix', fix),
    reportError: (err) => ipcRenderer.send('geo:error', err),
    retry: () => ipcRenderer.send('geo:retry'),
    openLocationSettings: () => ipcRenderer.send('geo:open-settings'),
    logout: () => ipcRenderer.send('agent:logout'),
    getState: () => ipcRenderer.invoke('state:get'),
    onState: (callback) => ipcRenderer.on('state', (_event, s) => callback(s)),
})
