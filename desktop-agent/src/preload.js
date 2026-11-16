'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Jembatan aman renderer <-> main (contextIsolation). Renderer tidak punya akses
 * Node; hanya fungsi di bawah ini.
 */
contextBridge.exposeInMainWorld('agent', {
    login: (creds) => ipcRenderer.invoke('login', creds),
    reportFix: (fix) => ipcRenderer.send('geo:fix', fix),
    reportError: (err) => ipcRenderer.send('geo:error', err),
    retry: () => ipcRenderer.send('geo:retry'),
    getState: () => ipcRenderer.invoke('state:get'),
    onState: (callback) => ipcRenderer.on('state', (_event, s) => callback(s)),
})
