"use strict";

// Módulo auxiliar de auto-update — importado pelo main.js
// Separado para facilitar mocks em testes e configuração via env.

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");

function setupUpdater(mainWindow) {
  // Em desenvolvimento, não verifica atualizações
  if (!app.isPackaged) {
    console.log("[updater] Skipping update check in dev mode");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for update...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] Update available:", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] Already up to date");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] Download: ${Math.round(progress.percent)}%`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] Update downloaded:", info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
      // Notifica o site via JS para mostrar banner de atualização
      mainWindow.webContents.executeJavaScript(
        `if (typeof window.__obaflixShowUpdate === 'function') window.__obaflixShowUpdate('${info.version}');`
      ).catch(() => {});
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] Error:", err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
  });

  // 1ª verificação 30s após inicio
  const firstCheck = setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("[updater]", e.message));
  }, 30000);

  // Recheck a cada 4h
  const interval = setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("[updater]", e.message));
  }, 4 * 60 * 60 * 1000);

  app.on("before-quit", () => {
    clearTimeout(firstCheck);
    clearInterval(interval);
  });
}

module.exports = { setupUpdater };
