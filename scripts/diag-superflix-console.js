/**
 * Diagnóstico SuperFlix — para colar no console do DevTools.
 *
 * Só observa: instrumenta fetch/XHR, lê o que a página já baixou e decodifica os
 * campos dos tokens. Não interfere na proteção do provedor nem envia nada para
 * fora do navegador.
 *
 * A saída sai redigida de propósito (host + caminho, sem query string, sem valor
 * de token) para poder ser colada num relatório sem vazar sessão.
 *
 * IMPORTANTE: um script no frame de cima não vê o tráfego dos iframes
 * (vizero/warezcdn são outra origem). Use o seletor de contexto do console —
 * o dropdown ao lado de "top" — e cole uma vez em cada frame da cadeia.
 *
 * Uso:
 *   1. Cole este arquivo inteiro no console.
 *   2. Reproduza o episódio normalmente, escolhendo um servidor.
 *   3. obaDiag.relatorio()
 *
 * Perguntas específicas:
 *   obaDiag.manifesto(url)  → o servidor devolve master com áudio/legenda?
 *   obaDiag.tokens()        → quais campos e qual validade os tokens carregam
 *   obaDiag.desafio()       → esta página é um desafio Cloudflare?
 *   obaDiag.usoUnico(url)   → instruções do teste que o CORS impede aqui
 */
(function () {
  "use strict";

  // O player do provedor chama console.clear() em laço e apaga a saída. Trava a
  // função como no-op antes de qualquer coisa; `configurable: false` impede que a
  // página restaure a original depois. Também vale marcar "Preserve log" nas
  // preferências do console — o Chrome passa a ignorar console.clear() sozinho.
  try {
    const limparOriginal = console.clear.bind(console);
    Object.defineProperty(console, "clear", {
      value: function () { /* neutralizado pelo obaDiag */ },
      writable: false,
      configurable: false,
    });
    window.__obaLimparConsole = limparOriginal;
  } catch (_) { /* console já protegido */ }

  const registros = [];
  const vistos = new Set();

  const ehCadeia = (host) => /superflixapi|vizero|warezcdn|embedplayer|hclod|qzz\.io/i.test(host);
  const ehMidia = (caminho) => /\.(?:m3u8|mp4|vtt|srt|ts|m4s)$|\/master\.txt$/i.test(caminho);

  function registrar(url, origem, extra) {
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return; }
    if (!/^https?:$/.test(parsed.protocol)) return;
    // Ruído de analytics/ads não ajuda em nada aqui.
    if (/doubleclick|googlesyndication|google-analytics|gtag/i.test(parsed.host)) return;
    if (!ehCadeia(parsed.host) && !ehMidia(parsed.pathname)) return;

    const chave = origem + "|" + parsed.host + parsed.pathname;
    if (vistos.has(chave)) return;
    vistos.add(chave);

    registros.push(Object.assign({
      origem,
      host: parsed.host,
      caminho: parsed.pathname.slice(0, 80),
      temQuery: parsed.search.length > 0,
      midia: ehMidia(parsed.pathname),
      t: new Date().toLocaleTimeString(),
    }, extra || {}));
  }

  // Recupera também o que já foi baixado antes deste script rodar (buffered).
  try {
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) registrar(e.name, "rede", { ms: Math.round(e.duration) });
    }).observe({ type: "resource", buffered: true });
  } catch (_) { /* navegador sem PerformanceObserver de resource */ }

  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === "function") {
    window.fetch = function (...args) {
      const alvo = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      return fetchOriginal.apply(this, args).then((resposta) => {
        registrar(alvo, "fetch", {
          status: resposta.status,
          tipo: (resposta.headers.get("content-type") || "?").split(";")[0],
        });
        return resposta;
      });
    };
  }

  const abrirOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.addEventListener("load", () => {
      registrar(url, "xhr", {
        status: this.status,
        tipo: (this.getResponseHeader("content-type") || "?").split(";")[0],
      });
    });
    return abrirOriginal.apply(this, arguments);
  };

  /** Decodifica o payload de um token, mostrando campos e validade — nunca o valor. */
  function decodificarToken(valor) {
    const parte = String(valor).split(".")[0];
    try {
      const b64 = parte.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
      if (!json || typeof json !== "object") return null;
      const resumo = {};
      for (const [chave, valorCampo] of Object.entries(json)) {
        resumo[chave] = typeof valorCampo === "string" && valorCampo.length > 40
          ? `<${valorCampo.length} chars>`
          : valorCampo;
      }
      if (typeof json.exp === "number" && json.exp > 0) {
        const ms = json.exp < 1e11 ? json.exp * 1000 : json.exp;
        resumo._expiraEm = new Date(ms).toLocaleString();
        resumo._faltamMin = Math.round((ms - Date.now()) / 60000);
      }
      return resumo;
    } catch (_) {
      return null;
    }
  }

  function tokens() {
    const alvos = [document.documentElement.innerHTML, location.search];
    const achados = [];
    const jaVistos = new Set();
    for (const texto of alvos) {
      for (const m of String(texto).matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g)) {
        const payload = decodificarToken(m[0]);
        if (!payload) continue;
        const assinatura = Object.keys(payload).sort().join(",");
        if (jaVistos.has(assinatura)) continue;
        jaVistos.add(assinatura);
        achados.push(payload);
      }
    }
    if (!achados.length) console.log("nenhum token decodificável nesta página");
    else console.table(achados);
    return achados.length;
  }

  function desafio() {
    const texto = document.documentElement.innerHTML.toLowerCase();
    const resultado = {
      pareceDesafio: /cf_chl_opt|turnstilesitekey|cf-turnstile|challenge-running|just a moment/.test(texto),
      bytesDoDocumento: document.documentElement.innerHTML.length,
      cookiesVisiveis: document.cookie
        ? document.cookie.split(";").map((c) => c.split("=")[0].trim()).join(", ")
        : "(nenhum)",
    };
    console.table(resultado);
    console.log(
      "cf_clearance é HttpOnly e nunca aparece em document.cookie.\n" +
      "Para validade e persistência: DevTools → Application → Cookies → o domínio,\n" +
      "e anote a coluna Expires."
    );
    return resultado;
  }

  /** Baixa um manifesto e resume o que ele oferece ao player. */
  async function manifesto(url) {
    if (!url) return console.log("uso: obaDiag.manifesto('https://.../master.m3u8')");
    try {
      const resposta = await fetch(url, { credentials: "include" });
      const texto = await resposta.text();
      if (!texto.trimStart().startsWith("#EXTM3U")) {
        return console.table({
          erro: "resposta não é manifesto",
          status: resposta.status,
          inicio: texto.slice(0, 60),
        });
      }
      const resultado = {
        status: resposta.status,
        master: /#EXT-X-STREAM-INF/.test(texto),
        qualidades: [...texto.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1]).join(" ") || "—",
        audios: [...texto.matchAll(/TYPE=AUDIO[^\n]*?NAME="([^"]+)"/g)].map((m) => m[1]).join(" | ") || "—",
        legendas: [...texto.matchAll(/TYPE=SUBTITLES[^\n]*?NAME="([^"]+)"/g)].map((m) => m[1]).join(" | ") || "—",
        linhas: texto.split("\n").length,
      };
      console.table(resultado);
      return resultado;
    } catch (erro) {
      console.warn(
        "fetch bloqueado (provavelmente CORS). Abra a URL numa aba nova: " +
        "navegação de topo não passa por CORS e você vê o manifesto cru.\n" +
        String(erro).slice(0, 100)
      );
      return null;
    }
  }

  function usoUnico() {
    console.log(
      [
        "Teste de uso único do master — o fetch daqui esbarra em CORS, então faça manual:",
        "",
        "1. Network → clique no master (.m3u8 ou master.txt) → Copy → Copy link address",
        "2. Cole numa aba nova. Anote se veio o texto do manifesto ou um erro.",
        "3. Recarregue essa mesma aba (F5) e compare.",
        "",
        "Se a 1a der manifesto e a 2a der 403/404, a URL é de uso único —",
        "e sondar o manifesto antes de tocar quebra a reprodução.",
      ].join("\n")
    );
  }

  function relatorio() {
    console.log("%c=== cadeia observada ===", "font-weight:bold");
    if (!registros.length) console.log("nada capturado ainda — reproduza um episódio e chame de novo");
    else console.table(registros);

    console.log("%c=== tokens nesta página ===", "font-weight:bold");
    tokens();

    console.log("%c=== estado do desafio ===", "font-weight:bold");
    desafio();

    const midias = registros.filter((r) => r.midia);
    if (midias.length) {
      console.log("%c=== mídia encontrada ===", "font-weight:bold");
      console.table(midias);
      console.log("rode obaDiag.manifesto(<url do master>) para ver qualidades/áudio/legenda");
    }

    console.log(
      "\nA saída acima já está redigida (sem query string e sem valor de token).\n" +
      "Confira mesmo assim antes de colar em qualquer lugar."
    );
  }

  /**
   * Devolve tudo como texto puro. Se a página conseguir limpar o console mesmo
   * assim, os dados continuam aqui: copie com copy(obaDiag.texto()).
   */
  function texto() {
    const linhas = ["# diagnostico superflix", "url: " + location.host + location.pathname, ""];
    linhas.push("## cadeia observada");
    for (const r of registros) {
      linhas.push(
        [r.t, r.origem, r.status || "-", r.tipo || "-", r.host + r.caminho, r.temQuery ? "?[query omitida]" : ""]
          .join("  ")
      );
    }
    linhas.push("", "## tokens");
    const html = document.documentElement.innerHTML;
    for (const m of String(html + location.search).matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/g)) {
      const payload = decodificarToken(m[0]);
      if (payload) linhas.push(JSON.stringify(payload));
    }
    linhas.push("", "## desafio");
    linhas.push(JSON.stringify({
      pareceDesafio: /cf_chl_opt|turnstile|challenge-running|just a moment/i.test(html),
      bytes: html.length,
      cookiesVisiveis: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean),
    }));
    return linhas.join("\n");
  }

  window.obaDiag = { relatorio, texto, manifesto, tokens, desafio, usoUnico, registros };

  console.log(
    "%cobaDiag pronto.%c  Reproduza um episódio e chame obaDiag.relatorio()\n" +
    "Lembre: rode também dentro do frame do vizero/warezcdn (seletor de contexto do console).",
    "color:#4ade80;font-weight:bold", "color:inherit"
  );
})();
