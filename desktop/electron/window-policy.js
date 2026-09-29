"use strict";

// ── Política de janelas, subframes, IPC e console da janela principal ────────
//
// Pura (sem `electron`), para ser testada por `node --test`. O main.js só
// executa o que sai daqui.
//
// Contexto: a Home/catálogo exibem um banner publicitário (Monetag) num iframe
// `sandbox` sem `allow-same-origin`, carregado de `/desktop/banner.html`
// (ver src/components/ads/BannerDesktop.tsx). O sandbox isola o script no
// renderer; estas regras fecham o que o sandbox não fecha no processo principal:
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
//     ERROR no log do usuário. Só esse frame; o resto segue como antes.

const DOCUMENTO_DO_BANNER = "/desktop/banner.html";
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

/** Só https sai para o navegador do sistema; qualquer outro esquema é descartado. */
function destinoExternoSeguro(raw) {
  const u = parse(raw);
  return u && u.protocol === "https:" ? u.href : null;
}

/**
 * `window.open` / `target=_blank` / clique do meio, de qualquer frame.
 * Retorna o que fazer; o chamador sempre responde `{ action: "deny" }`.
 */
function decidirJanelaNova(url, appOrigin) {
  if (!ehDoApp(url, appOrigin) || ehRotaExterna(url, appOrigin)) {
    const externo = destinoExternoSeguro(url);
    return externo ? { acao: "externo", url: externo } : { acao: "negar", motivo: "esquema" };
  }
  return { acao: "negar", motivo: "janela_do_app" };
}

/**
 * Navegação de subframe. Só o iframe do banner é restringido: ele fica no
 * próprio documento. Players embed (/assistir) e demais iframes seguem livres,
 * como sempre — são eles que tocam o vídeo.
 */
function decidirNavegacaoDeSubframe({ isMainFrame, urlAtual, destino, appOrigin }) {
  if (isMainFrame) return "seguir";
  if (!ehDocumentoDoBanner(urlAtual, appOrigin)) return "seguir";
  return ehDocumentoDoBanner(destino, appOrigin) ? "seguir" : "cancelar";
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
  if (isMainFrame === false && ehDocumentoDoBanner(frameUrl, appOrigin)) return "trace";
  return NIVEL_DO_CONSOLE[level] || "debug";
}

module.exports = {
  DOCUMENTO_DO_BANNER,
  ehDoApp,
  ehRotaExterna,
  ehDocumentoDoBanner,
  destinoExternoSeguro,
  decidirJanelaNova,
  decidirNavegacaoDeSubframe,
  ipcConfiavel,
  nivelDoConsole,
};
