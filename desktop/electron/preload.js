"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Bridge exposta para o site Obaflix detectar ambiente desktop
// e usar extração nativa de streams (sem CORS).
contextBridge.exposeInMainWorld("obaflixDesktop", {
  // Indica que está rodando no app desktop
  isDesktop: true,

  // Extrai stream de player embed (rola3/rola4) via processo principal (sem CORS)
  // Retorna: { stream: string, tipo: "hls"|"mp4" } | { error: string }
  extractStream: (embedUrl) => ipcRenderer.invoke("extract-stream", embedUrl),

  // Toggle tela cheia nativa
  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),

  // Versão do aplicativo
  getVersion: () => ipcRenderer.invoke("get-version"),

  // Instala atualização baixada (chama quit + install)
  installUpdate: () => ipcRenderer.invoke("install-update"),

  // Callback chamado quando atualização é baixada
  // O main.js chama window.__obaflixShowUpdate() após download
  onUpdateReady: (cb) => {
    window.__obaflixShowUpdate = cb;
  },
});
