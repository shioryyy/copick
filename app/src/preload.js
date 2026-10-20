'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Two fixed surfaces; no arbitrary channels, file access, or clipboard text from renderers.
if (location.pathname.endsWith('/popup.html')) {
  contextBridge.exposeInMainWorld('copickPopup', {
    onSelection: callback => ipcRenderer.on('popup:selection', (_event, token) => callback(token)),
    copy: token => ipcRenderer.invoke('popup:copy', token)
  });
} else if (location.pathname.endsWith('/settings.html')) {
  contextBridge.exposeInMainWorld('copickSettings', {
    read: () => ipcRenderer.invoke('settings:read'),
    save: value => ipcRenderer.invoke('settings:save', value),
    onState: callback => ipcRenderer.on('settings:state', (_event, value) => callback(value)),
    openAccessibility: () => ipcRenderer.invoke('settings:open-accessibility'),
    openLoginItems: () => ipcRenderer.invoke('settings:open-login-items')
  });
}
