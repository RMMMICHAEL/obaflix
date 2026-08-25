/**
 * Valida a cadeia completa do Hide comparando Website e Electron sobre o MESMO
 * conteúdo real, etapa por etapa:
 *
 *   detecção do provider → ordem dos espelhos → extração → Referer →
 *   resolução da master → validação da master → entrega → tratamento de erro
 *
 * O Android roda o mesmo fluxo em Kotlin e não é executável aqui; a paridade dele
 * é garantida por compilação e revisão lado a lado (ver CLAUDE.md).
 *
 * Uso:  npx tsx scripts/validar-hide-tres-ambientes.ts <url> [url...]
 */

import { ehHostHide, ordemEspelhosHide, validarMasterHide } from "../src/lib/hideMaster";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractStream, detectProvider } = require("../desktop/electron/extractors.js");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36";

type Linha = {
  url: string;
  webProvider: string;
  webEspelho: string;
  webReferer: string;
  webVeredito: string;
  webInline: number;
  eleProvider: string;
  eleReferer: string;
  eleResultado: string;
};

/** Reproduz a cadeia do Website: espelhos → página → parser → validação. */
async function pelaWeb(url: string) {
  const hostname = new URL(url).hostname;
  const id = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";

  if (!ehHostHide(hostname)) {
    return { provider: "—", espelho: "—", referer: "—", veredito: "nao-roteado", inline: 0 };
  }

  let paginaUsada = url;
  let html: string | null = null;
  for (const host of ordemEspelhosHide(hostname)) {
    const pagina = `https://${host}/v/${id}`;
    try {
      const res = await fetch(pagina, {
        headers: { "User-Agent": UA, Referer: "https://megaflix.lat/" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
      paginaUsada = pagina;
      break;
    } catch { /* tenta o próximo espelho */ }
  }
  if (!html) {
    return { provider: "hide", espelho: "nenhum", referer: "—", veredito: "sem-pagina", inline: 0 };
  }

  // Recorte do packer idêntico ao extractEvalScript das três implementações:
  // indexOf do cabeçalho + busca pelo fecho `.split('|'),0,{}))`.
  let stream: string | null = null;
  const idx = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (idx !== -1) {
    const chunk = html.slice(idx, idx + 50000);
    const fim = chunk.search(/\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)/);
    const bruto = fim !== -1 ? chunk.slice(0, fim + 30) : chunk.slice(0, chunk.indexOf("</script>"));
    try {
      const { runInContext, createContext } = await import("node:vm");
      // O packer chama eval(); capturamos o argumento em vez de executá-lo.
      let decodificado: string | null = null;
      runInContext(bruto, createContext({ eval: (s: string) => { decodificado = s; } }), { timeout: 1000 });
      const out = String(decodificado ?? "");
      const links = JSON.parse(out.split("var links=")[1].split(";")[0].trim());
      stream = links.hls3 || links.hls2 || links.hls4 || null;
      if (stream && !stream.startsWith("http")) stream = new URL(paginaUsada).origin + stream;
    } catch { /* parser falhou */ }
  }
  if (!stream) {
    return { provider: "hide", espelho: new URL(paginaUsada).hostname, referer: paginaUsada, veredito: "sem-stream", inline: 0 };
  }

  const v = await validarMasterHide(stream, paginaUsada);
  return {
    provider: "hide",
    espelho: new URL(paginaUsada).hostname,
    referer: paginaUsada,
    veredito: v.motivo + (v.status ? ` (${v.status})` : ""),
    inline: v.manifest?.length ?? 0,
  };
}

/** Cadeia do Electron: o código real, sem simulação. */
async function peloElectron(url: string) {
  const provider = detectProvider(url) ?? "—";
  try {
    const r = await extractStream(url);
    return { provider, referer: r.referer ?? "—", resultado: `ok (${new URL(r.stream).hostname})` };
  } catch (e: any) {
    return { provider, referer: "—", resultado: `erro: ${String(e.message).slice(0, 52)}` };
  }
}

(async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("uso: npx tsx scripts/validar-hide-tres-ambientes.ts <url> [url...]");
    process.exit(1);
  }

  const linhas: Linha[] = [];
  for (const url of urls) {
    process.stderr.write(`  verificando ${url} ...\n`);
    const [web, ele] = await Promise.all([pelaWeb(url), peloElectron(url)]);
    linhas.push({
      url,
      webProvider: web.provider,
      webEspelho: web.espelho,
      webReferer: web.referer,
      webVeredito: web.veredito,
      webInline: web.inline,
      eleProvider: ele.provider,
      eleReferer: ele.referer,
      eleResultado: ele.resultado,
    });
  }

  console.log("\n=== Website x Electron, mesmo conteúdo ===\n");
  for (const l of linhas) {
    const id = l.url.split("/").pop();
    const refIgual = l.webReferer === l.eleReferer || l.eleReferer === "—";
    // Só "removido" (404/410) rejeita a fonte. "inconclusivo" — 403, 5xx,
    // timeout, erro de rede — entrega o stream mesmo assim, por definição.
    const webRejeita = l.webVeredito.startsWith("removido");
    const eleRejeita = !l.eleResultado.startsWith("ok");
    const coerente = webRejeita === eleRejeita;
    console.log(`${id}`);
    console.log(`  provider    web=${l.webProvider}  electron=${l.eleProvider}   ${l.webProvider === l.eleProvider ? "IGUAL" : "DIFERE"}`);
    console.log(`  espelho     ${l.webEspelho}`);
    console.log(`  referer     web=${l.webReferer}`);
    console.log(`              ele=${l.eleReferer}   ${refIgual ? "IGUAL" : "DIFERE"}`);
    console.log(`  master      web=${l.webVeredito}  inline=${l.webInline}b`);
    console.log(`  electron    ${l.eleResultado}`);
    console.log(`  veredito    ${coerente ? "COERENTE" : "*** DIVERGENTE ***"}\n`);
  }

  const divergentes = linhas.filter((l) => {
    const webRejeita = l.webVeredito.startsWith("removido");
    const eleRejeita = !l.eleResultado.startsWith("ok");
    return webRejeita !== eleRejeita || (l.eleReferer !== "—" && l.webReferer !== l.eleReferer);
  });
  console.log(divergentes.length === 0
    ? `Todos os ${linhas.length} itens coerentes entre Website e Electron.`
    : `${divergentes.length} de ${linhas.length} DIVERGEM.`);
  process.exit(divergentes.length === 0 ? 0 : 1);
})();
