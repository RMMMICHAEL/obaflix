"use strict";

const { WebContentsView } = require("electron");

const APP_URL =
  process.env.OBAFLIX_URL ||
  "https://obaflix.vercel.app";

let activeExtraction = null;

// Janela de espera após a primeira mídia, para capturar legendas e um eventual
// manifesto HLS melhor. Igual ao SUPERFLIX_SUBTITLE_GRACE_MS do extrator Android.
const MEDIA_SETTLE_MS = 1800;

function safeLabel(raw) {
  try {
    const url = new URL(raw);

    return `${url.hostname}${url.pathname}`
      .slice(0, 180);
  } catch {
    return String(raw || "")
      .split("?")[0]
      .slice(0, 180);
  }
}

function headerValue(headers, wantedName) {
  const wanted =
    String(wantedName).toLowerCase();

  for (
    const [name, value]
    of Object.entries(headers || {})
  ) {
    if (
      String(name).toLowerCase() === wanted
    ) {
      return String(value || "");
    }
  }

  return "";
}

function isHls(url) {
  return (
    /\.m3u8(?:$|\?)/i.test(url) ||
    /\/cdn\/hls\/[^/]+\/master\.txt(?:$|\?)/i
      .test(url)
  );
}

function isMp4(url) {
  return /\.mp4(?:$|\?)/i.test(url);
}

function isInteresting(url) {
  return (
    /superflixapi\.pro/i.test(url) ||
    /warezcdn/i.test(url) ||
    /xn--kcksk7a2bl5le7b6doc1h3f/i
      .test(url) ||
    /\/player\/source/i.test(url) ||
    /\/player\/redirect/i.test(url) ||
    /\/player\/native/i.test(url) ||
    isHls(url) ||
    isMp4(url)
  );
}

function createWrapperHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
    }

    #superflix-frame {
      position: fixed;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #000;
    }

    #loading {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      background: #000;
      font: 16px Arial, sans-serif;
      pointer-events: none;
    }

    #close-superflix {
      position: fixed;
      top: 14px;
      right: 16px;
      z-index: 2147483647;
      width: 42px;
      height: 42px;
      border: 1px solid rgba(255,255,255,.35);
      border-radius: 50%;
      color: #fff;
      background: rgba(15,15,18,.9);
      font-size: 22px;
      line-height: 38px;
      cursor: pointer;
    }

    #close-superflix:hover {
      background: rgba(210,35,35,.95);
    }
  </style>
</head>

<body>
  <div id="loading">
    Carregando servidores do SuperFlix...
  </div>

  <button
    id="close-superflix"
    type="button"
    title="Fechar seleção de servidor"
    onclick="location.href='obaflix-superflix://close'"
  >
    ×
  </button>

  <iframe
    id="superflix-frame"
    allow="autoplay; fullscreen; encrypted-media"
  ></iframe>
</body>
</html>`;
}

async function extractSuperflixInBrowser(
  embedUrl,
  {
    parentWindow,
    wrapperUrl,
    partition = "persist:obaflix",
    timeoutMs = 120000,
  } = {},
) {
  const input = new URL(embedUrl);

  if (
    input.hostname !== "superflixapi.pro" &&
    !input.hostname.endsWith(
      ".superflixapi.pro",
    )
  ) {
    throw new Error(
      "URL SuperFlix inválida.",
    );
  }

  if (
    !parentWindow ||
    parentWindow.isDestroyed()
  ) {
    throw new Error(
      "Janela principal indisponível para abrir o SuperFlix.",
    );
  }

  if (activeExtraction) {
    activeExtraction.cancel(
      "Extração anterior substituída por um novo episódio.",
    );

    activeExtraction = null;
  }

  console.log(
    `[superflix-overlay] iniciando: ${safeLabel(embedUrl)}`,
  );

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy:
        "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  const webContents =
    view.webContents;

  const webContentsId =
    webContents.id;

  const ses =
    webContents.session;

  const referers =
    new Map();

  let settled = false;
  let timeout = null;

  const belongsToView = (details) => {
    return (
      !details.webContentsId ||
      details.webContentsId ===
        webContentsId
    );
  };

  const updateBounds = () => {
    if (
      parentWindow.isDestroyed()
    ) {
      return;
    }

    const [width, height] =
      parentWindow.getContentSize();

    view.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, width),
      height: Math.max(1, height),
    });
  };

  parentWindow.contentView
    .addChildView(view);

  updateBounds();

  parentWindow.on(
    "resize",
    updateBounds,
  );

  return new Promise(
    (resolve, reject) => {
      const subtitleTracks = new Map();
      let mediaFinishTimer = null;
      let pendingMedia = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (mediaFinishTimer) {
          clearTimeout(mediaFinishTimer);
          mediaFinishTimer = null;
        }

        parentWindow.removeListener(
          "resize",
          updateBounds,
        );

        ses.webRequest
          .onSendHeaders(null);

        ses.webRequest
          .onBeforeRedirect(null);

        ses.webRequest
          .onCompleted(null);

        referers.clear();

        try {
          if (
            !parentWindow.isDestroyed()
          ) {
            parentWindow.contentView
              .removeChildView(view);
          }
        } catch {
          // A view pode já ter sido removida.
        }

        try {
          if (
            !webContents.isDestroyed()
          ) {
            webContents.close();
          }
        } catch {
          // O renderer pode já ter sido encerrado.
        }

        if (
          activeExtraction?.view === view
        ) {
          activeExtraction = null;
        }
      };

      const finish = (
        error,
        result,
      ) => {
        if (settled) return;

        settled = true;
        cleanup();

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      activeExtraction = {
        view,

        cancel(reason) {
          finish(
            new Error(
              reason ||
              "Seleção do SuperFlix cancelada.",
            ),
          );
        },
      };

      const capture = (
        stream,
        referer,
        statusCode,
      ) => {
        if (
          settled ||
          !stream ||
          statusCode < 200 ||
          statusCode >= 400
        ) {
          return;
        }

        const completeMedia = (tipo) => {
          // Um MP4 visto primeiro não pode travar a escolha: se um manifesto HLS
          // aparecer dentro da janela, ele traz qualidades, áudio e legendas.
          if (pendingMedia && !(tipo === "hls" && pendingMedia.tipo !== "hls")) return;
          pendingMedia = { stream, tipo, referer: referer || embedUrl };
          if (mediaFinishTimer) return;
          // Dá ao player incorporado uma janela para requisitar VTT/SRT depois que
          // o manifesto/vídeo começa a carregar. Mesma espera do extrator Android.
          mediaFinishTimer = setTimeout(() => finish(null, {
            ...pendingMedia,
            subtitles: [...subtitleTracks.values()],
          }), MEDIA_SETTLE_MS);
        };

        if (isHls(stream)) {
          console.log(
            `[superflix-overlay] HLS capturado: ${safeLabel(stream)}`,
          );

          completeMedia("hls");

          return;
        }

        if (
          isMp4(stream) &&
          (
            statusCode === 200 ||
            statusCode === 206
          )
        ) {
          console.log(
            `[superflix-overlay] MP4 capturado: ${safeLabel(stream)}`,
          );

          completeMedia("mp4");
        }
      };

      ses.webRequest.onSendHeaders(
        {
          urls: ["*://*/*"],
        },
        (details) => {
          if (
            settled ||
            !belongsToView(details)
          ) {
            return;
          }

          const referer =
            details.referrer ||
            headerValue(
              details.requestHeaders,
              "referer",
            ) ||
            embedUrl;

          referers.set(
            details.id,
            referer,
          );
        },
      );

      ses.webRequest.onBeforeRedirect(
        {
          urls: ["*://*/*"],
        },
        (details) => {
          if (
            settled ||
            !belongsToView(details)
          ) {
            return;
          }

          const redirectUrl =
            details.redirectURL || "";

          if (
            isInteresting(details.url) ||
            isInteresting(redirectUrl)
          ) {
            console.log(
              `[superflix-overlay/redirect] ${details.statusCode} ` +
              `${safeLabel(details.url)} -> ` +
              `${safeLabel(redirectUrl)}`,
            );
          }

          if (
            !isMp4(redirectUrl) &&
            !isHls(redirectUrl)
          ) {
            return;
          }

          const referer =
            referers.get(details.id) ||
            details.referrer ||
            details.url ||
            embedUrl;

          const tipo =
            isHls(redirectUrl)
              ? "hls"
              : "mp4";

          console.log(
            `[superflix-overlay] ${tipo.toUpperCase()} capturado no redirecionamento: ` +
            safeLabel(redirectUrl),
          );

          capture(redirectUrl, referer, 200);
        },
      );

      ses.webRequest.onCompleted(
        {
          urls: ["*://*/*"],
        },
        (details) => {
          if (
            settled ||
            !belongsToView(details)
          ) {
            return;
          }

          const referer =
            referers.get(details.id) ||
            details.referrer ||
              embedUrl;

          if (/\.(?:vtt|srt|ass|ssa)(?:$|\?)/i.test(details.url) && details.statusCode >= 200 && details.statusCode < 400) {
            subtitleTracks.set(details.url, {
              file: details.url,
              label: "Português",
              kind: "captions",
              default: subtitleTracks.size === 0,
              referer,
            });
            console.log(`[superflix-overlay] legenda capturada: ${safeLabel(details.url)}`);
          }

          if (
            isInteresting(details.url)
          ) {
            console.log(
              `[superflix-overlay/net] ${details.statusCode} ` +
              `${details.resourceType} ` +
              safeLabel(details.url),
            );
          }

          capture(
            details.url,
            referer,
            details.statusCode,
          );

          referers.delete(
            details.id,
          );
        },
      );

      webContents.setWindowOpenHandler(
        () => ({
          action: "deny",
        }),
      );

      webContents.on(
        "before-input-event",
        (event, inputEvent) => {
          if (
            inputEvent.type === "keyDown" &&
            inputEvent.key === "Escape"
          ) {
            event.preventDefault();

            finish(
              new Error(
                "Seleção de servidor cancelada pelo usuário.",
              ),
            );
          }
        },
      );

      webContents.on(
        "will-navigate",
        (event, url) => {
          if (
            url.startsWith(
              "obaflix-superflix://close",
            )
          ) {
            event.preventDefault();

            finish(
              new Error(
                "Seleção de servidor cancelada pelo usuário.",
              ),
            );
          }
        },
      );

      webContents.once(
        "render-process-gone",
        () => {
          finish(
            new Error(
              "O processo do SuperFlix foi encerrado inesperadamente.",
            ),
          );
        },
      );

      timeout = setTimeout(
        () => {
          finish(
            new Error(
              "Tempo esgotado aguardando a seleção de servidor do SuperFlix.",
            ),
          );
        },
        timeoutMs,
      );

      const resolvedWrapperUrl =
        wrapperUrl ||
        (
          APP_URL.replace(/\/+$/, "") +
          "/superflix-wrapper.html"
        );

      webContents
        .loadURL(resolvedWrapperUrl)
        .then(() => {
          if (settled) return;

          console.log(
            "[superflix-overlay] wrapper local estatico carregado",
          );

          const script = `
            (() => {
              const frame =
                document.getElementById(
                  "superflix-frame"
                );

              const loading =
                document.getElementById(
                  "superflix-loading"
                );

              if (!frame) {
                throw new Error(
                  "iframe SuperFlix não encontrado no wrapper"
                );
              }

              frame.addEventListener(
                "load",
                () => {
                  if (loading) {
                    loading.remove();
                  }
                },
                {
                  once: true,
                },
              );

              frame.src =
                ${JSON.stringify(embedUrl)};

              return true;
            })()
          `;

          return webContents.executeJavaScript(
            script,
            true,
          );
        })
        .then(() => {
          if (settled) return;

          updateBounds();

          console.log(
            "[superflix-overlay] navegacao do iframe iniciada",
          );
        })
        .catch((error) => {
          finish(error);
        });
    },
  );
}

module.exports = {
  extractSuperflixInBrowser,
};
