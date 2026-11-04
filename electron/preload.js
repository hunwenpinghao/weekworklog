'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('worklog', {
  listEntries: (week) => ipcRenderer.invoke('entries:list', week),
  createEntry: (body) => ipcRenderer.invoke('entries:create', body),
  updateEntry: (id, body) => ipcRenderer.invoke('entries:update', id, body),
  deleteEntry: (id) => ipcRenderer.invoke('entries:delete', id),
  confirmDelete: (message) => ipcRenderer.invoke('dialog:confirmDelete', message),
  exportWeek: (week) => ipcRenderer.invoke('export:week', week),
  dataPath: () => ipcRenderer.invoke('store:path'),
  onMenuExport: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:export', handler);
    return () => ipcRenderer.removeListener('menu:export', handler);
  },
});
