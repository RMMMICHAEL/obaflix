"use strict";

// ── Política de janelas, subframes, IPC e console da janela principal ────────
//
// Pura (sem `electron`), para ser testada por `node --test`. O main.js só
// executa o que sai daqui.
//
// Contexto: a Home/catálogo exibem um banner publicitário (Monetag) num iframe
// **sem `sandbox`** carregado de `https://obaflix-ads.vercel.app/banner.html`
// (ver src/components/ads/BannerDesktop.tsx e ads-site/README.md): a tag não
// entrega em iframe sandboxed. Ser outro site isola DOM, ponte e storage do
// app; tudo o que o sandbox fazia no resto é feito aqui, no processo principal.
// O documento antigo, sandboxed, `/desktop/banner.html` na origem do app,
// continua reconhecido enquanto um site sem esta versão estiver no ar.
//
//  1. **nenhum `window.open` cria janela Electron.** Antes, URL do próprio app
//     virava `{ action: "allow" }`: a filha herdava o preload privilegiado e não
//     tinha guarda de navegação. Um anúncio podia abrir uma URL do app e depois
//     navegar essa janela sem barra de endereço para um site qualquer. Só não
//     acontecia porque o header COOP da Vercel cortava o `opener` — fronteira
//     alheia ao Electron. O site não abre janela própria (auditado: os únicos
//     `_blank` são IMDb e "abrir fonte original", ambos externos), então negar
//     não tira nada de quem usa o app;
//  2. **IPC só do frame principal da janela principal**, além da origem;
//  3. **o iframe do banner não navega para fora do próprio documento** (o
//     clique legítimo do anúncio usa `window.open`, que cai na regra 1);
//  4. **console do iframe do banner vai para `trace`**: a tag re-tenta
//     IndexedDB (negado na origem opaca) ~1x/s e cada falha virava uma linha
//     ERROR no log do usuário. Só esse frame; o resto segue como antes;
//  5. **o anúncio nunca troca a janela principal.** Sem sandbox, o frame do
//     anúncio navegou o topo para outro site sem gesto (medido). Navegação do
//     frame principal iniciada pelo frame do anúncio ou por qualquer frame
//     dentro dele é recusada — e **não** vai ao navegador (seria um popunder).
//     Iniciador desconhecido (frame já destruído) indo para fora do app também;
//  6. **download só da origem do app.** O `DownloadItem` não diz qual frame o
//     iniciou, então não dá para atribuir ao anúncio um download servido por
//     terceiro. O app não baixa nada pelo navegador (a mídia vai por
//     media-download.js), então qualquer download com URL fora do app —
//     anúncio inclusive — é cancelado;
//  7. **nenhuma permissão para a origem dos anúncios**, nem as que o app libera
//     para si (fullscreen, pointerLock, mediaKeySystem);
//  8. **janela nova só vai ao navegador com gesto real.** O Electron repassa
//     `window.open` sem ativação do usuário (medido: o anúncio abria o
//     navegador do sistema sozinho, em laço). O main.js registra o último
//     clique/tecla/toque de verdade (`input-event`, que script não forja) e
//     cada gesto vale uma abertura só, por até `JANELA_DO_GESTO_MS`;
//  9. **nada sai ao navegador sem gesto real**, por nenhum caminho: além do
//     `window.open`, a navegação do frame principal para fora do app, o link
//     patrocinado (anúncio recompensado) e o anúncio por clique (Direct Link)
//     exigem e consomem o mesmo gesto.

const DOCUMENTO_DO_BANNER = "/desktop/banner.html";
/** Site isolado dos anúncios (ads-site/). Mesma constante de src/lib/ads/bannerDesktop.ts. */
const ORIGEM_DOS_ANUNCIOS = "https://obaflix-ads.vercel.app";
const DOCUMENTO_DOS_ANUNCIOS = "/banner.html";
/**
 * Quanto tempo um gesto real autoriza abrir o navegador. Curto de propósito: o
 * gesto vale para a janela inteira (o `input-event` não diz o frame), então um
 * clique no app não pode virar, segundos depois, janela aberta pelo anúncio. O
 * app não usa `window.open`; os links `_blank` abrem no mesmo clique.
 */
const JANELA_DO_GESTO_MS = 1000;
/** Tipos de `input-event` que contam como gesto. Movimento e rolagem não contam. */
/**
 * Piso do intervalo entre duas aberturas do anúncio por clique, imposto aqui,
 * independente do que o servidor configurar (ver `LIMITES_DA_FREQUENCIA` em
 * src/lib/ads/cliqueDesktop.ts, cujo mínimo é o mesmo).
 */
const COOLDOWN_MINIMO_DO_CLIQUE_MS = 30_000;
const GESTOS = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchStart", "touchEnd", "gestureTap", "pointerDown", "pointerUp"]);
const ROTA_EXTERNA = /^\/(planos|checkout)(?:\/|$)/;

function parse(raw) {
  try { return new URL(raw); } catch { return null; }
}

function ehDoApp(raw, appOrigin) {
  const u = parse(raw);
  return !!u && u.origin === appOrigin;
}

/** /planos e /checkout: do app, mas abrem no navegador do sistema. */
function ehRotaExterna(raw, appOrigin) {
  const u = parse(raw);
  return !!u && u.origin === appOrigin && ROTA_EXTERNA.test(u.pathname);
}

/** O documento isolado do banner, exatamente (sem querystring nem hash de outra rota). */
function ehDocumentoDoBanner(raw, appOrigin) {
  const u = parse(raw);
  return !!u && u.origin === appOrigin && u.pathname === DOCUMENTO_DO_BANNER;
}

/**
 * Qualquer URL da origem dos anúncios. `blob:` herda a origem de quem criou
 * (`new URL("blob:https://x/…").origin === "https://x"`), então conta também.
 */
function ehOrigemDeAnuncio(raw) {
  const u = parse(raw);
  return !!u && u.origin === ORIGEM_DOS_ANUNCIOS;
}

/** Documento de anúncio: o do ads-site ou o antigo, sandboxed, na origem do app. */
function ehFrameDeAnuncio(raw, appOrigin) {
  if (ehDocumentoDoBanner(raw, appOrigin)) return true;
  const u = parse(raw);
  return !!u && u.origin === ORIGEM_DOS_ANUNCIOS && u.pathname === DOCUMENTO_DOS_ANUNCIOS;
}

/** Só https sai para o navegador do sistema; qualquer outro esquema é descartado. */
function destinoExternoSeguro(raw) {
  const u = parse(raw);
  return u && u.protocol === "https:" ? u.href : null;
}

/**
 * `window.open` / `target=_blank` / clique do meio, de qualquer frame.
 * Retorna o que fazer; o chamador sempre responde `{ action: "deny" }`.
 * `gestoRecente` tem de ser `true` para sair ao navegador (fail-closed).
 */
function decidirJanelaNova(url, appOrigin, { gestoRecente } = {}) {
  if (!ehDoApp(url, appOrigin) || ehRotaExterna(url, appOrigin)) {
    const externo = destinoExternoSeguro(url);
    if (!externo) return { acao: "negar", motivo: "esquema" };
    return gestoRecente === true ? { acao: "externo", url: externo } : { acao: "negar", motivo: "sem_gesto" };
  }
  return { acao: "negar", motivo: "janela_do_app" };
}

/**
 * Navegação do frame principal para fora do app (ou para /planos, /checkout),
 * depois de `decidirNavegacaoPrincipal` dizer "seguir": só https e só com
 * gesto real vai ao navegador do sistema. Sem gesto, é recusada sem abrir nada.
 */
function decidirSaidaExterna(url, { gestoRecente } = {}) {
  const externo = destinoExternoSeguro(url);
  if (!externo) return { acao: "negar", motivo: "esquema" };
  return gestoRecente === true ? { acao: "externo", url: externo } : { acao: "negar", motivo: "sem_gesto" };
}

/**
 * Link patrocinado do anúncio recompensado: exatamente a URL homologada, só
 * https, só com gesto real.
 */
function decidirLinkPatrocinado({ pedida, homologada, gestoRecente }) {
  if (typeof pedida !== "string" || pedida !== homologada) return { acao: "negar", motivo: "url" };
  if (!destinoExternoSeguro(homologada)) return { acao: "negar", motivo: "esquema" };
  return gestoRecente === true ? { acao: "abrir", url: homologada } : { acao: "negar", motivo: "sem_gesto" };
}

/**
 * Anúncio por clique (Direct Link). A URL é a do processo principal — o
 * renderer não manda nenhuma. Só https, gesto real e piso de intervalo.
 */
function decidirAnuncioDeClique({ url, gestoRecente, agora, ultimaAberturaEm }) {
  if (!destinoExternoSeguro(url)) return { acao: "negar", motivo: "esquema" };
  if (gestoRecente !== true) return { acao: "negar", motivo: "sem_gesto" };
  if (ultimaAberturaEm > 0 && agora - ultimaAberturaEm < COOLDOWN_MINIMO_DO_CLIQUE_MS) {
    return { acao: "negar", motivo: "intervalo" };
  }
  return { acao: "abrir", url: destinoExternoSeguro(url) };
}

/** Houve gesto real há no máximo `JANELA_DO_GESTO_MS`? `ultimoGestoEm` 0 = consumido/nunca. */
function gestoRecente(ultimoGestoEm, agora) {
  return ultimoGestoEm > 0 && agora - ultimoGestoEm >= 0 && agora - ultimoGestoEm <= JANELA_DO_GESTO_MS;
}

/**
 * Navegação de subframe. Só o iframe do banner é restringido: ele fica no
 * próprio documento (só o hash muda). Os frames que a tag cria dentro dele
 * carregam o criativo e seguem livres; players embed (/assistir) e demais
 * iframes também, como sempre — são eles que tocam o vídeo.
 */
function decidirNavegacaoDeSubframe({ isMainFrame, urlAtual, destino, appOrigin }) {
  if (isMainFrame) return "seguir";
  if (!ehFrameDeAnuncio(urlAtual, appOrigin)) return "seguir";
  const a = parse(urlAtual);
  const d = parse(destino);
  return d && d.origin === a.origin && d.pathname === a.pathname && d.search === a.search ? "seguir" : "cancelar";
}

/**
 * Navegação do frame principal (`will-navigate`/`will-frame-navigate`), pela
 * cadeia do iniciador: URL e origem do frame que iniciou e de cada ancestral,
 * até o topo. `null` = iniciador desconhecido.
 *
 *  - `"bloquear"`: veio do anúncio ou de um frame dentro dele (qualquer destino,
 *    do app ou não), ou de iniciador desconhecido para fora do app. Não abre
 *    nada no navegador do sistema;
 *  - `"seguir"`: segue a regra de sempre do main.js (app navega dentro; fora
 *    do app vai ao navegador do sistema, só https).
 */
function decidirNavegacaoPrincipal({ destino, cadeiaDoIniciador, appOrigin }) {
  if (!Array.isArray(cadeiaDoIniciador) || cadeiaDoIniciador.length === 0) {
    return ehDoApp(destino, appOrigin) ? "seguir" : "bloquear";
  }
  const doAnuncio = cadeiaDoIniciador.some((f) =>
    !!f && (ehOrigemDeAnuncio(f.origin) || ehOrigemDeAnuncio(f.url) || ehFrameDeAnuncio(f.url, appOrigin)));
  return doAnuncio ? "bloquear" : "seguir";
}

/**
 * Download no navegador: só quando toda a cadeia de redirecionamento está na
 * origem do app. Qualquer outra (anúncio, terceiro, `data:`, `blob:` alheio,
 * cadeia vazia) é cancelada.
 */
function decidirDownload({ cadeiaDeUrls, appOrigin }) {
  if (!Array.isArray(cadeiaDeUrls) || cadeiaDeUrls.length === 0) return "cancelar";
  return cadeiaDeUrls.every((u) => ehDoApp(u, appOrigin)) ? "permitir" : "cancelar";
}

/**
 * Permissão pedida/consultada: a origem dos anúncios não recebe nenhuma, nem
 * como quem pede nem como quem emoldura. O resto segue a lista do app.
 */
function permissaoLiberada({ permissao, origens, liberadas }) {
  if ((origens || []).some((o) => ehOrigemDeAnuncio(o))) return false;
  return liberadas.has(permissao);
}

/**
 * IPC privilegiado: o remetente tem de ser o frame principal (`parent === null`)
 * da janela principal, com a origem do app. Subframe de mesma origem — o
 * iframe do banner inclusive — não passa, mesmo que um dia recebesse preload.
 */
function ipcConfiavel({ remetenteEhJanelaPrincipal, ehFramePrincipal, urlDoFrame, appOrigin }) {
  return remetenteEhJanelaPrincipal === true && ehFramePrincipal === true && ehDoApp(urlDoFrame, appOrigin);
}

const NIVEL_DO_CONSOLE = { debug: "debug", info: "debug", warning: "warn", error: "error" };

/**
 * Nível de log de uma mensagem de console da página. Mantém o mapeamento
 * anterior (info → debug, warning → warn, error → error) para todo frame,
 * exceto o iframe do banner, que vai para `trace`.
 */
function nivelDoConsole({ level, isMainFrame, frameUrl, appOrigin }) {
  if (isMainFrame === false && ehFrameDeAnuncio(frameUrl, appOrigin)) return "trace";
  return NIVEL_DO_CONSOLE[level] || "debug";
}

module.exports = {
  DOCUMENTO_DO_BANNER,
  ORIGEM_DOS_ANUNCIOS,
  JANELA_DO_GESTO_MS,
  COOLDOWN_MINIMO_DO_CLIQUE_MS,
  GESTOS,
  gestoRecente,
  decidirSaidaExterna,
  decidirLinkPatrocinado,
  decidirAnuncioDeClique,
  ehDoApp,
  ehRotaExterna,
  ehDocumentoDoBanner,
  ehOrigemDeAnuncio,
  ehFrameDeAnuncio,
  destinoExternoSeguro,
  decidirJanelaNova,
  decidirNavegacaoDeSubframe,
  decidirNavegacaoPrincipal,
  decidirDownload,
  permissaoLiberada,
  ipcConfiavel,
  nivelDoConsole,
};
