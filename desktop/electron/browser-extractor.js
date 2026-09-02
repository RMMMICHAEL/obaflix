"use strict";

const { WebContentsView, webFrameMain, BrowserWindow, net } = require("electron");
const { shareInFlightResolution } = require("./superflix-extractor");

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
    authorizationOnly = false,
    userAgent = null,
  } = {},
) {
  const input = new URL(embedUrl);

  if (
    !/(^|\.)superflixapi\.(pro|sbs|beer)$/i.test(input.hostname)
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
      sandbox: true,
      autoplayPolicy:
        "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  const webContents =
    view.webContents;
  if (userAgent) webContents.setUserAgent(userAgent);

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
          authorizationOnly ||
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
            /(^|\.)superflixapi\.(pro|sbs|beer)$/i.test(destino.hostname);

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

          if (authorizationOnly) {
            // Apenas observa se a resposta legítima já é a página autorizada.
            // Não lê nem transfere PAGE_TOKEN/cfv para fora do frame e não toca
            // no widget: o usuário conclui o Turnstile normalmente.
            frame.executeJavaScript(`(() => {
              const html = document.documentElement?.outerHTML || "";
              return (html.includes("/player/bootstrap") || html.includes("/player/source")) &&
                /content[_-]?id|contentid/i.test(html) &&
                !/cf_embed_challenge|challenge-running/i.test(html);
            })()`)
              .then(async (authorized) => {
                if (!authorized || settled) return;
                const cookies = await ses.cookies.get({});
                finish(null, {
                  authorizedUrl: frame.url,
                  cookies: cookies.map(({ name, value, domain, path, secure, httpOnly, sameSite, expirationDate }) => ({
                    name, value, domain, path, secure, httpOnly, sameSite, expirationDate,
                  })),
                  ua: webContents.getUserAgent(),
                });
              })
              .catch(() => { /* o próximo carregamento tenta novamente */ });
            return;
          }

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
              authorizationOnly
                ? "Tempo esgotado aguardando a verificação do SuperFlix."
                : "Tempo esgotado aguardando a seleção de servidor do SuperFlix.",
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

              if (aviso && ${JSON.stringify(Boolean(authorizationOnly))}) {
                aviso.textContent = "Conclua a verificação para continuar no Obaflix.";
              }

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

// ── Observação do fluxo legítimo de embeds sem API nativa conhecida ─────────
//
// Algumas variantes do EmbedPlayer (ex.: Fire Player) nunca expuseram o POST
// legado /player/index.php?do=getVideo que extractEmbedPlayer() usa — só
// entregam mídia pelo fluxo real da própria página: challenge JS automático,
// depois o player carrega o manifesto por conta própria. Reproduzir esse
// challenge nós mesmos está fora de cogitação; em vez disso, deixamos uma
// sessão Electron comum carregar a página de verdade e observamos qual mídia
// ela mesma obtém — sem tentar contornar Cloudflare, gerar token ou adivinhar
// nomes de rota ofuscados.
//
// Sessão dedicada (persist:obaflix-embed), separada da usada pelo overlay
// interativo de escolha de servidor: as duas registram os próprios listeners
// em session.webRequest, e webRequest permite só UM listener por evento por
// sessão — registros concorrentes se substituiriam silenciosamente.

const EMBED_OBSERVER_PARTITION = "persist:obaflix-embed";
const EMBED_OBSERVER_TIMEOUT_MS = 20000;

// Mesma ideia do overlay: uma media isolada não trava a escolha — se um
// manifesto master aparecer dentro da janela, ele traz qualidades e áudios.
const EMBED_MEDIA_SETTLE_MS = 1500;

const activeEmbedObservations = new Map();

function bufferLooksLikeM3u8(buf) {
  if (!buf || buf.length < 7) return false;
  const head = buf.slice(0, 32).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("#EXTM3U");
}

function bufferLooksLikeMp4(buf) {
  if (!buf || buf.length < 12) return false;
  const brand = buf.slice(4, 8).toString("ascii");
  return brand === "ftyp" || brand === "styp" || brand === "moof";
}

function m3u8Kind(text) {
  if (/#EXT-X-STREAM-INF/i.test(text)) return "master";
  if (/#EXTINF/i.test(text)) return "media";
  return "unknown";
}

/** Range curto: barato mesmo quando o candidato acaba sendo um segmento binário grande. */
function sniffCandidate(ses, url, { referer, ua, rangeBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const req = net.request({ method: "GET", url, session: ses });
      req.setHeader("Accept", "*/*");
      if (ua) req.setHeader("User-Agent", ua);
      if (referer) req.setHeader("Referer", referer);
      req.setHeader("Range", `bytes=0-${rangeBytes - 1}`);
      const chunks = [];
      let total = 0;
      req.on("response", (res) => {
        res.on("data", (chunk) => {
          if (total >= rangeBytes) return;
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on("end", () => finish({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", () => finish(null));
      });
      req.on("error", () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/** Corpo completo — só chamado depois que sniffCandidate() já confirmou um manifesto de texto pequeno. */
function fetchFullText(ses, url, { referer, ua, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const req = net.request({ method: "GET", url, session: ses });
      req.setHeader("Accept", "*/*");
      if (ua) req.setHeader("User-Agent", ua);
      if (referer) req.setHeader("Referer", referer);
      const chunks = [];
      let total = 0;
      req.on("response", (res) => {
        res.on("data", (chunk) => {
          if (total > maxBytes) return;
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => finish(null));
      });
      req.on("error", () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/** Classe grosseira da rota, só para diagnóstico — nunca a URL/path completos. */
function embedRouteClass(pathname) {
  if (pathname === "/" || /^\/video\//i.test(pathname)) return "page";
  if (pathname.startsWith("/layer/")) return "layer";
  if (pathname.startsWith("/cdn-cgi/")) return "challenge";
  return "asset";
}

async function runEmbedObservation(embedUrl, { referer, ua, partition, timeoutMs }) {
  let win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  const webContents = win.webContents;
  if (ua) webContents.setUserAgent(ua);
  const webContentsId = webContents.id;
  const ses = webContents.session;

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    let settleTimer = null;
    let pendingMedia = null;
    const subtitleTracks = new Map();
    const checked = new Set();

    const cleanup = () => {
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      try { ses.webRequest.onCompleted(null); } catch { /* sessão já pode ter sumido */ }
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* já destruída */ }
      win = null;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const armSettle = () => {
      if (settleTimer || settled) return;
      settleTimer = setTimeout(() => {
        if (!settled && pendingMedia) {
          finish({ ...pendingMedia, referer: embedUrl, subtitles: [...subtitleTracks.values()] });
        }
      }, EMBED_MEDIA_SETTLE_MS);
    };

    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
      if (settled || details.webContentsId !== webContentsId) return;

      let parsed;
      try { parsed = new URL(details.url); } catch { return; }

      if (
        /\.(?:vtt|srt|ass|ssa)(?:$|\?)/i.test(details.url) &&
        details.statusCode >= 200 && details.statusCode < 400
      ) {
        subtitleTracks.set(details.url, {
          file: details.url,
          label: "Português",
          kind: "captions",
          default: subtitleTracks.size === 0,
          referer: embedUrl,
        });
      }

      if (details.statusCode < 200 || details.statusCode >= 400) return;
      // xhr/fetch/other cobre como hls.js e o player buscam manifesto e
      // segmentos; scripts, folhas de estilo e imagens nunca são a mídia.
      if (!["xhr", "fetch", "other"].includes(details.resourceType)) return;

      const contentType = headerValue(details.responseHeaders || {}, "content-type").toLowerCase();
      // Filtro por Content-Type é só economia de uma checagem — a confirmação
      // real é sempre pelo corpo, porque este provedor já disfarça segmento
      // como text/plain em outras rotas conhecidas do mesmo ecossistema.
      if (/^(image|font|text\/css|text\/html|(?:application|text)\/javascript)/i.test(contentType)) return;
      if (checked.has(details.url)) return;
      checked.add(details.url);

      const routeClass = embedRouteClass(parsed.pathname);
      console.log(`[embed-observe/net] host=${parsed.hostname} classe=${routeClass} status=${details.statusCode}`);

      sniffCandidate(ses, details.url, { referer: embedUrl, ua })
        .then(async (sniffed) => {
          if (settled || !sniffed?.body?.length) return;

          if (bufferLooksLikeM3u8(sniffed.body)) {
            const head = sniffed.body.toString("utf8");
            const kind = m3u8Kind(head);
            console.log(`[embed-observe] media=hls host=${parsed.hostname} classe=${kind}`);

            if (kind === "master") {
              const full = await fetchFullText(ses, details.url, { referer: embedUrl, ua });
              if (settled) return;
              finish({
                stream: details.url,
                referer: embedUrl,
                tipo: "hls",
                manifestBody: full || head,
                subtitles: [...subtitleTracks.values()],
              });
              return;
            }

            if (kind === "media" && !pendingMedia) {
              const full = await fetchFullText(ses, details.url, { referer: embedUrl, ua });
              if (settled || pendingMedia) return;
              pendingMedia = { stream: details.url, tipo: "hls", manifestBody: full || head };
              armSettle();
            }
            return;
          }

          if (bufferLooksLikeMp4(sniffed.body)) {
            console.log(`[embed-observe] media=mp4 host=${parsed.hostname}`);
            finish({
              stream: details.url,
              referer: embedUrl,
              tipo: "mp4",
              subtitles: [...subtitleTracks.values()],
            });
          }
        })
        .catch(() => { /* candidato não confirmado — segue observando */ });
    });

    webContents.once("render-process-gone", () => finish(null));

    timeout = setTimeout(() => finish(null), timeoutMs);

    webContents
      .loadURL(embedUrl, referer ? { httpReferrer: referer } : undefined)
      .catch(() => finish(null));
  });
}

/**
 * Observa uma sessão Electron comum carregando `embedUrl` e devolve a mídia
 * que a própria página obtiver (HLS ou MP4, confirmada pelo conteúdo — nunca
 * pelo nome da rota). `null` quando nada é observado dentro do prazo.
 *
 * Uma navegação ativa por vez por URL: uma segunda chamada para a mesma fonte
 * enquanto a primeira ainda está em andamento reaproveita a mesma Promise em
 * vez de abrir outra janela/navegação paralela.
 */
function observeEmbedMediaInBrowser(embedUrl, {
  referer = null,
  ua = null,
  partition = EMBED_OBSERVER_PARTITION,
  timeoutMs = EMBED_OBSERVER_TIMEOUT_MS,
} = {}) {
  return shareInFlightResolution(activeEmbedObservations, embedUrl, () =>
    runEmbedObservation(embedUrl, { referer, ua, partition, timeoutMs }));
}

module.exports = {
  extractSuperflixInBrowser,
  authorizeSuperflixInBrowser: (embedUrl, options = {}) =>
    extractSuperflixInBrowser(embedUrl, { ...options, authorizationOnly: true }),
  observeEmbedMediaInBrowser,
};
