"use strict";

const { WebContentsView, webFrameMain } = require("electron");

/** Destinos de compartilhamento do provedor — o botão do Telegram e afins. */
function ehHostDeCompartilhamento(hostname) {
  const host = String(hostname || "").toLowerCase();
  return /(^|\.)(t\.me|telegram\.me|telegram\.org|wa\.me|whatsapp\.com|facebook\.com|twitter\.com|x\.com)$/.test(host);
}

/**
 * Roda dentro do iframe do provedor, via webFrameMain (privilégio de processo
 * principal, então não esbarra em same-origin).
 *
 * Neutraliza o que tira o usuário da nossa organização: o rodapé de
 * compartilhamento e os links que saem da tela de servidores. A identificação é
 * pelo texto e pelo destino porque a marcação do provedor é ofuscada e não tem
 * classe estável para ancorar seletor.
 */
const LIMPEZA_PAGINA_PROVEDOR = `
(() => {
  const ROTULOS = ["copiar link", "copiar", "copy link", "telegram"];

  function limpar() {
    document.querySelectorAll("a,button,li,div,span").forEach((el) => {
      const texto = (el.textContent || "").trim().toLowerCase();
      if (!texto || texto.length > 24) return;
      if (!ROTULOS.includes(texto)) return;
      const alvo = el.closest("a,button,li") || el;
      alvo.style.setProperty("display", "none", "important");
    });

    document.querySelectorAll("a[href]").forEach((a) => {
      let destino;
      try { destino = new URL(a.href, location.href); } catch (e) { return; }
      const saiDaOrigem = destino.origin !== location.origin;
      const noPlayer = destino.pathname.indexOf("/player/") === 0 ||
        destino.search.indexOf("cfv=") >= 0 ||
        destino.pathname === location.pathname;
      if (saiDaOrigem || !noPlayer) {
        a.style.setProperty("pointer-events", "none", "important");
        a.removeAttribute("target");
      }
    });
  }

  limpar();
  // O modal de servidores monta depois do load, então repete por alguns
  // segundos em vez de depender de um único instante.
  let restantes = 30;
  const timer = setInterval(() => {
    limpar();
    if (--restantes <= 0) clearInterval(timer);
  }, 500);
  return true;
})()
`;

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
    /xn--kcksk7a2bl5le7b6doc1h3f|xn--tckasiu6cvova0eb5fua2449g98vg/i
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

    /* Mesmo carregamento dos outros players do app: fundo preto e spinner com o
       topo vermelho da marca, sem texto sobre o provedor. */
    #superflix-loading {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      pointer-events: none;
    }

    #superflix-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(255,255,255,.2);
      border-top-color: #E50914;
      border-radius: 50%;
      animation: sf-spin 1s linear infinite;
    }

    @keyframes sf-spin {
      to { transform: rotate(360deg); }
    }

    #superflix-aviso {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2147483646;
      display: none;
      padding: 14px 64px 26px;
      background: linear-gradient(180deg, rgba(0,0,0,.92), rgba(0,0,0,0));
      color: #fff;
      font: 14px/1.45 Arial, Helvetica, sans-serif;
      text-align: center;
      pointer-events: none;
      text-shadow: 0 1px 3px rgba(0,0,0,.9);
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
  <div id="superflix-loading">
    <div id="superflix-spinner"></div>
  </div>

  <div id="superflix-aviso">
    Escolha um servidor para assistir. Recomendamos o Servidor Alternativo, se
    estiver disponível.
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
    !/(^|\.)superflixapi\.(pro|sbs)$/i.test(input.hostname)
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

      // Telegram e afins abrem janela nova; nada aqui deve escapar do overlay.
      webContents.setWindowOpenHandler(
        ({ url }) => {
          console.log(
            `[superflix-overlay] popup bloqueado: ${safeLabel(url)}`,
          );

          return { action: "deny" };
        },
      );

      // A seta de voltar do provedor leva para a página de episódio deles, que
      // foge da nossa organização. Bloquear a navegação deixa o botão sem efeito
      // sem precisar adivinhar o seletor dele.
      let primeiraNavegacaoDoIframe = true;

      webContents.on(
        "will-frame-navigate",
        (event) => {
          if (event.isMainFrame) return;

          if (primeiraNavegacaoDoIframe) {
            primeiraNavegacaoDoIframe = false;
            return;
          }

          let destino;
          try {
            destino = new URL(event.url);
          } catch (_) {
            return;
          }

          // Lista do que BLOQUEAR, não do que permitir. Uma lista de permissão
          // derrubaria o desafio do Cloudflare, que navega frames para
          // challenges.cloudflare.com, e a troca para o host do servidor
          // escolhido, que muda de domínio.
          const ehSuperflix =
            /(^|\.)superflixapi\.(pro|sbs)$/i.test(destino.hostname);

          const parteDoPlayer =
            destino.pathname.startsWith("/player/") ||
            destino.pathname.startsWith("/cdn-cgi/") ||
            destino.searchParams.has("cfv") ||
            destino.pathname === input.pathname;

          const ehCompartilhamento = ehHostDeCompartilhamento(destino.hostname);

          // Navegar para outra página de conteúdo do provedor é a seta de voltar.
          if (!ehCompartilhamento && !(ehSuperflix && !parteDoPlayer)) return;

          event.preventDefault();

          console.log(
            `[superflix-overlay] navegacao do iframe bloqueada: ${safeLabel(event.url)}`,
          );
        },
      );

      webContents.on(
        "did-frame-finish-load",
        (_event, isMainFrame, frameProcessId, frameRoutingId) => {
          if (isMainFrame || settled) return;

          let frame = null;
          try {
            frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
          } catch (_) {
            return;
          }
          if (!frame) return;

          frame
            .executeJavaScript(LIMPEZA_PAGINA_PROVEDOR)
            .then(() => {
              console.log(
                "[superflix-overlay] botoes do provedor neutralizados",
              );
            })
            .catch((error) => {
              // Falhar aqui é cosmético: a navegação já está bloqueada.
              console.warn(
                "[superflix-overlay] limpeza da pagina falhou: " +
                  String(error?.message || error).slice(0, 80),
              );
            });
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

              const aviso =
                document.getElementById(
                  "superflix-aviso"
                );

              frame.addEventListener(
                "load",
                () => {
                  if (loading) {
                    loading.remove();
                  }

                  if (aviso) {
                    aviso.style.display =
                      "block";
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
