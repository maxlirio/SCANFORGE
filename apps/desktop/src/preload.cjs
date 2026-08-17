// Bridge between the sandboxed renderer and the shell. Deliberately tiny: the
// renderer gets file bytes and a couple of shell actions, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanforge', {
  desktop: true,
  platform: process.platform,
  pickPhotos: () => ipcRenderer.invoke('scanforge:pick-photos'),
  readFile: (filePath) => ipcRenderer.invoke('scanforge:read-file', filePath),
  reveal: (target) => ipcRenderer.invoke('scanforge:reveal', target),
  onOpenFiles: (handler) => {
    const listener = (_event, paths, options) => handler(paths, options || {});
    ipcRenderer.on('scanforge:open-files', listener);
    return () => ipcRenderer.removeListener('scanforge:open-files', listener);
  },
});
