"use strict";

const { BrowserWindow } = require("electron");

const APP_URL =
  process.env.OBAFLIX_URL || "https://obaflix.vercel.app";

function safeLabel(raw) {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`.slice(0, 180);
  } catch {
    return String(raw).split("?")[0].slice(0, 180);
  }
}

function headerValue(headers, wantedName) {
  const wanted = wantedName.toLowerCase();

  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === wanted) {
      return String(value || "");
    }
  }

  return "";
}

function isHls(url) {
  return (
    /\.m3u8(?:$|\?)/i.test(url) ||
    /\/cdn\/hls\/[^/]+\/master\.txt(?:$|\?)/i.test(url)
  );
}

function isMp4(url) {
  return /\.mp4(?:$|\?)/i.test(url);
}

function isInteresting(url) {
  return (
    /superflixapi\.pro/i.test(url) ||
    /warezcdn/i.test(url) ||
    /xn--kcksk7a2bl5le7b6doc1h3f/i.test(url) ||
    /\/player\/source/i.test(url) ||
    /\/player\/redirect/i.test(url) ||
    /\/player\/native/i.test(url) ||
    isHls(url) ||
    isMp4(url)
  );
}

async function extractSuperflixInBrowser(
  embedUrl,
  {
    partition = "persist:obaflix",
    timeoutMs = 90000,
  } = {},
) {
  const input = new URL(embedUrl);

  if (
    input.hostname !== "superflixapi.pro" &&
    !input.hostname.endsWith(".superflixapi.pro")
  ) {
    throw new Error("URL SuperFlix inválida para fallback Chromium");
  }

  console.log(
    `[superflix-browser] iniciando: ${safeLabel(embedUrl)}`,
  );

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: "#000000",
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  const ses = win.webContents.session;
  const referers = new Map();

  let timeout = null;
  let settled = false;

  const belongsToWindow = (details) => {
    return (
      !details.webContentsId ||
      details.webContentsId === win.webContents.id
    );
  };

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);

    // Esses três eventos não são utilizados pelo main.js.
    ses.webRequest.onSendHeaders(null);
    ses.webRequest.onBeforeRedirect(null);
    ses.webRequest.onCompleted(null);

    referers.clear();

    if (!win.isDestroyed()) {
      win.destroy();
    }
  };

  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      if (settled) return;

      settled = true;
      cleanup();

      if (error) reject(error);
      else resolve(result);
    };

    const capture = (stream, referer, statusCode) => {
      if (!stream || statusCode < 200 || statusCode >= 400) {
        return;
      }

      if (isHls(stream)) {
        console.log(
          `[superflix-browser] HLS capturado: ${safeLabel(stream)}`,
        );

        finish(null, {
          stream,
          tipo: "hls",
          referer: referer || embedUrl,
        });

        return;
      }

      if (
        isMp4(stream) &&
        (statusCode === 200 || statusCode === 206)
      ) {
        console.log(
          `[superflix-browser] MP4 capturado: ${safeLabel(stream)}`,
        );

        finish(null, {
          stream,
          tipo: "mp4",
          referer: referer || null,
        });
      }
    };

    ses.webRequest.onSendHeaders(
      { urls: ["*://*/*"] },
      (details) => {
        if (!belongsToWindow(details)) return;

        const referer =
          details.referrer ||
          headerValue(details.requestHeaders, "referer") ||
          embedUrl;

        referers.set(details.id, referer);
      },
    );

    ses.webRequest.onBeforeRedirect(
      { urls: ["*://*/*"] },
      (details) => {
        if (!belongsToWindow(details)) return;

        if (
          isInteresting(details.url) ||
          isInteresting(details.redirectURL || "")
        ) {
          console.log(
            `[superflix-browser/redirect] ${details.statusCode} ` +
            `${safeLabel(details.url)} -> ` +
            `${safeLabel(details.redirectURL)}`,
          );
        }
      },
    );

    ses.webRequest.onCompleted(
      { urls: ["*://*/*"] },
      (details) => {
        if (!belongsToWindow(details)) return;

        const referer =
          referers.get(details.id) ||
          details.referrer ||
          embedUrl;

        if (isInteresting(details.url)) {
          console.log(
            `[superflix-browser/net] ${details.statusCode} ` +
            `${details.resourceType} ${safeLabel(details.url)}`,
          );
        }

        capture(details.url, referer, details.statusCode);
        referers.delete(details.id);
      },
    );

    timeout = setTimeout(() => {
      finish(
        new Error(
          "Timeout aguardando mídia no iframe do SuperFlix",
        ),
      );
    }, timeoutMs);

    win.webContents.setWindowOpenHandler(() => ({
      action: "deny",
    }));

    win.loadURL(APP_URL)
      .then(() => {
        const iframeScript = `
          window.stop();

          document.open();
          document.write(
            '<!doctype html>' +
            '<html>' +
            '<head>' +
            '<meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<style>' +
            'html,body{width:100%;height:100%;margin:0;background:#000;overflow:hidden}' +
            'iframe{display:block;width:100%;height:100%;border:0}' +
            '</style>' +
            '</head>' +
            '<body>' +
            '<iframe id="superflix-frame" ' +
            'allow="autoplay; fullscreen; encrypted-media"></iframe>' +
            '</body>' +
            '</html>'
          );

          document.close();

          document.getElementById("superflix-frame").src =
            ${JSON.stringify(embedUrl)};
        `;

        return win.webContents.executeJavaScript(iframeScript);
      })
      .then(() => {
        console.log(
          "[superflix-browser] SuperFlix aberto dentro do iframe",
        );
      })
      .catch((error) => {
        finish(error);
      });
  });
}

module.exports = { extractSuperflixInBrowser };