const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("boopDesktop", {
  getStatus: () => ipcRenderer.invoke("boop:get-status"),
  start: () => ipcRenderer.invoke("boop:start"),
  stop: () => ipcRenderer.invoke("boop:stop"),
  restart: () => ipcRenderer.invoke("boop:restart"),
  checkWebhook: () => ipcRenderer.invoke("boop:check-webhook"),
  openDashboard: () => ipcRenderer.invoke("boop:open-dashboard"),
  showRuntimeFolder: () => ipcRenderer.invoke("boop:show-runtime-folder"),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("boop-status", listener);
    return () => ipcRenderer.removeListener("boop-status", listener);
  },
  onOpenDashboard: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("boop-open-dashboard", listener);
    return () => ipcRenderer.removeListener("boop-open-dashboard", listener);
  },
});
