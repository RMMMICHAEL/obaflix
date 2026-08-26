/**
 * Mede quanto tráfego de mídia passa pela Vercel numa reprodução, comparando o
 * fluxo web (antes) com a extração nativa (depois) para a mesma fonte.
 *
 * Não estima: extrai de verdade, lê a playlist real e amostra o tamanho dos
 * segmentos. Também confere se o Referer do embed continua sendo exigido pelo
 * CDN — é ele que o main.js injeta em cada segmento no caminho nativo.
 *
 * Uso:  npx tsx scripts/medir-transfer-electron.ts [--amostra N] <url> [url...]
 */

// Arquivo isolado: sem isto os scripts compartilham escopo global no tsc.
export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractStream } = require("../desktop/electron/extractors.js");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

const MB = (b: number) => (b / 1024 / 1024).toFixed(1);

type Medida = {
  fonte: string;
  provider: string;
  cdn: string;
  embed: string;
  segmentos: number;
  duracaoSeg: number;
  bytesMidia: number;
  bytesManifesto: number;
  refererExigido: boolean | null;
};

async function baixar(url: string, referer: string | null) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
  if (referer) {
    headers.Referer = referer;
    try { headers.Origin = new URL(referer).origin; } catch { /* referer torto */ }
  }
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
  return { status: res.status, texto: res.ok ? await res.text() : "", headers: res.headers };
}

/**
 * Tamanho do segmento. Tenta primeiro sem baixar o corpo (Range de 1 byte
 * devolve Content-Range com o total); alguns CDNs — hclod.qzz.io entre eles —
 * ignoram Range e não mandam Content-Length, e aí não há alternativa a baixar.
 */
async function tamanhoDe(url: string, referer: string | null): Promise<number> {
  const base: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
  if (referer) {
    base.Referer = referer;
    try { base.Origin = new URL(referer).origin; } catch { /* referer torto */ }
  }
  try {
    const res = await fetch(url, {
      headers: { ...base, Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const cr = res.headers.get("content-range");
    if (cr) {
      const total = Number(cr.split("/")[1]);
      if (Number.isFinite(total) && total > 1) return total;
    }
    const cl = Number(res.headers.get("content-length") ?? 0);
    if (cl > 1) return cl;
  } catch { /* cai para a medição por download */ }

  try {
    const res = await fetch(url, { headers: base, redirect: "follow", signal: AbortSignal.timeout(25000) });
    if (!res.ok) return 0;
    return (await res.arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

async function medir(fonte: string, amostra: number): Promise<Medida | null> {
  let r: any;
  try {
    r = await extractStream(fonte);
  } catch (e: any) {
    console.log(`  ${fonte}\n    extração falhou: ${String(e.message).slice(0, 90)}`);
    return null;
  }

  const referer: string = r.referer;
  let bytesManifesto = 0;

  const master = await baixar(r.stream, referer);
  if (master.status !== 200) {
    console.log(`  ${fonte}\n    master http ${master.status}`);
    return null;
  }
  bytesManifesto += master.texto.length;

  // Desce até a playlist de mídia, se o master listar variantes.
  let playlistUrl = r.stream;
  let texto = master.texto;
  if (texto.includes("#EXT-X-STREAM-INF")) {
    const variante = texto.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!variante) return null;
    playlistUrl = new URL(variante, r.stream).href;
    const p = await baixar(playlistUrl, referer);
    if (p.status !== 200) return null;
    bytesManifesto += p.texto.length;
    texto = p.texto;
  }

  const linhas = texto.split("\n").map((l) => l.trim());
  const segmentos = linhas
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, playlistUrl).href);
  const duracaoSeg = linhas
    .filter((l) => l.startsWith("#EXTINF"))
    .reduce((soma, l) => soma + (parseFloat(l.split(":")[1]) || 0), 0);

  // Amostra os primeiros N segmentos e extrapola — medir 600 seria caro e inútil.
  const n = Math.min(amostra, segmentos.length);
  let somaAmostra = 0;
  for (let i = 0; i < n; i++) somaAmostra += await tamanhoDe(segmentos[i], referer);
  const medio = n > 0 ? somaAmostra / n : 0;

  // O Referer é exigido? Se sim, é ele que o main.js precisa injetar.
  let refererExigido: boolean | null = null;
  if (segmentos.length) {
    try {
      const semRef = await fetch(segmentos[0], {
        headers: { "User-Agent": UA, Accept: "*/*" },
        signal: AbortSignal.timeout(15000),
      });
      refererExigido = !semRef.ok;
    } catch { refererExigido = null; }
  }

  return {
    fonte,
    provider: r.provider,
    cdn: (() => { try { return new URL(r.stream).hostname; } catch { return "?"; } })(),
    embed: (() => { try { return new URL(referer).hostname; } catch { return "?"; } })(),
    segmentos: segmentos.length,
    duracaoSeg,
    bytesMidia: Math.round(medio * segmentos.length),
    bytesManifesto,
    refererExigido,
  };
}

(async () => {
  const args = process.argv.slice(2);
  const iAmostra = args.indexOf("--amostra");
  const amostra = iAmostra >= 0 ? Number(args[iAmostra + 1]) : 12;
  const fontes = args.filter((a, i) => !a.startsWith("--") && i !== iAmostra + 1);
  if (!fontes.length) {
    console.error("uso: npx tsx scripts/medir-transfer-electron.ts [--amostra N] <url> [url...]");
    process.exit(1);
  }

  const medidas: Medida[] = [];
  for (const f of fontes) {
    const m = await medir(f, amostra);
    if (m) medidas.push(m);
  }

  console.log("\n=== Tráfego de mídia por fonte ===\n");
  for (const m of medidas) {
    const min = (m.duracaoSeg / 60).toFixed(0);
    console.log(`${m.provider} — ${m.cdn}`);
    console.log(`  embed (Referer)   ${m.embed}`);
    console.log(`  conteúdo          ${m.segmentos} segmentos, ~${min} min, ~${MB(m.bytesMidia)} MB`);
    console.log(`  manifestos        ${(m.bytesManifesto / 1024).toFixed(0)} KB`);
    console.log(`  Referer exigido   ${m.refererExigido === null ? "indeterminado" : m.refererExigido ? "SIM — main.js precisa injetar" : "não"}`);
    console.log(`  ANTES (web)       Vercel: 2 + ${m.segmentos} requests | ${MB(m.bytesMidia + m.bytesManifesto)} MB de Transfer Out`);
    console.log(`  DEPOIS (nativo)   Vercel: 0 requests | 0.0 MB — mídia e manifesto vão direto ao CDN\n`);
  }

  const totalAntes = medidas.reduce((s, m) => s + m.bytesMidia + m.bytesManifesto, 0);
  const reqAntes = medidas.reduce((s, m) => s + m.segmentos + 2, 0);
  console.log(`Total nas ${medidas.length} fontes medidas:`);
  console.log(`  antes:  ${reqAntes} requests na Vercel, ${MB(totalAntes)} MB de Transfer Out`);
  console.log(`  depois: 0 requests na Vercel, 0.0 MB`);
})();
