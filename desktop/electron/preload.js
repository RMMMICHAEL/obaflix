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

  // Superflix em duas etapas: o Chromium aparece somente se a sessão precisar
  // de autorização; depois o seletor e a resolução pertencem ao Obaflix.
  prepareSuperflix: (embedUrl) => ipcRenderer.invoke("superflix-prepare", embedUrl),
  resolveSuperflix: (sessionId, optionKey) =>
    ipcRenderer.invoke("superflix-resolve", sessionId, optionKey),

  // Google OAuth no navegador do sistema. O main guarda o verifier PKCE e
  // recebe somente o ticket assinado pelo protocolo obaflix://.
  startGoogleLogin: (callbackUrl) => ipcRenderer.invoke("desktop-google-login", callbackUrl),

  // Assinatura/pagamento (/planos, /checkout) abrem no navegador do sistema.
  // O clique num next/link navega por History API e escapa do will-navigate;
  // por isso o renderer entrega a URL aqui. O main valida origem + rota antes
  // de shell.openExternal — o renderer nunca escolhe um destino arbitrário.
  openExternal: (url) => ipcRenderer.invoke("desktop-open-external", url),

  // Abre somente o Direct Link homologado e confirma que o SO aceitou a abertura.
  openSponsoredLink: (url) => ipcRenderer.invoke("open-sponsored-link", url),

  // Toggle tela cheia nativa
  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),

  // Baixa a mídia que o player está reproduzindo, na pasta Downloads.
  // pedido: { stream, referer, tipo, titulo, modo: "completo"|"trecho", inicioSeg, fimSeg }
  // Retorna: { ok: true, caminho, bytes, container } | { error: string, cancelado?: true }
  downloadMedia: (pedido) => ipcRenderer.invoke("download-media", pedido),
  cancelDownload: () => ipcRenderer.invoke("cancel-download"),
  revealDownload: (caminho) => ipcRenderer.invoke("reveal-download", caminho),

  // Progresso: { etapa, atual, total, bytes, pct }
  onDownloadProgress: (cb) => {
    ipcRenderer.removeAllListeners("download-progress");
    ipcRenderer.on("download-progress", (_evento, p) => { try { cb(p); } catch { /**/ } });
  },

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
