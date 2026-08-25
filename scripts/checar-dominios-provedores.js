// Verifica se algum provedor fixo no codigo migrou de dominio.
//
// Esses provedores trocam de dominio com frequencia e a falha e SILENCIOSA: nao
// ha erro, o detectProvider apenas deixa de reconhecer e o player cai no iframe
// sem extracao nativa. Foi assim que superflixapi.pro -> .sbs passou despercebido.
//
// Uso:  node scripts/checar-dominios-provedores.js
//
// Quando aparecer "PRECISA DE AJUSTE", o host de destino precisa entrar em
// detectProvider (Kotlin, Electron e rota web), EMBED_HOSTNAMES do main.js,
// PROVIDER_HOSTS do mediaProviders.ts e na lista do cloudflare-worker.
const path = require("path");
const dns = require("dns").promises;
const { detectProvider } = require(path.join(__dirname, "..", "desktop/electron/extractors.js"));
const { _test: superflix } = require(path.join(__dirname, "..", "desktop/electron/superflix-extractor.js"));

/**
 * Um host pode ser reconhecido de duas formas: por detectProvider, quando tem
 * extrator próprio, ou como host de cadeia (Vizero/WarezCDN), que só aparece no
 * meio do caminho até a mídia. Sem checar as duas, host de cadeia vira falso
 * positivo e o relatório perde utilidade.
 */
function ehReconhecido(host) {
  if (detectProvider("https://" + host + "/x")) return "extrator";
  const html = '<a href="https://' + host + '/player/redirect?t=x"></a>';
  const aceitos = superflix.collectChainUrls(html, "https://superflixapi.sbs/serie/1/1/1");
  return aceitos.length ? "host de cadeia" : null;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Hosts que aparecem fixos em detectProvider / EMBED_HOSTNAMES / PROVIDER_HOSTS.
const HOSTS = [
  "playerflix.ink",
  "superflixapi.pro",
  "superflixapi.sbs",
  "embedplayer1.xyz",
  "embedplayer2.xyz",
  "xn--kcksk7a2bl5le7b6doc1h3f.com",
  "v1.watchplay.shop",
  "vizero.buzz",
  "warezcdn.lat",
  "playhide.shop",
  "playerwish.com",
  "luluvdo.com",
  "boltcdn.xyz",
  "bigshare.link",
  "vods.faz-o-eli.online",
  "llanfairpwllgwyngy.com",
  "vsembed.su",
  "cloudorchestranova.com",
];

async function checar(host) {
  const url = "https://" + host + "/";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const loc = r.headers.get("location");
    let destinoHost = null;
    if (loc) { try { destinoHost = new URL(loc, url).hostname; } catch { /**/ } }
    return { status: r.status, redirecionaPara: destinoHost && destinoHost !== host ? destinoHost : null };
  } catch (e) {
    // Distingue provedor caído de problema de rede local. Se o DNS resolve mas a
    // conexão não fecha, o host morreu — foi assim que playhide.shop passou
    // despercebido como "fetch failed", tratado como ruído da minha máquina
    // quando na verdade derrubava o provedor inteiro.
    let dnsOk = false;
    try { await dns.lookup(host); dnsOk = true; } catch { /**/ }
    return {
      status: 0,
      erro: String(e.message || e).slice(0, 40),
      provavelmenteMorto: dnsOk,
    };
  }
}

(async () => {
  console.log("host".padEnd(36) + "HTTP".padEnd(7) + "detectProvider".padEnd(16) + "observacao");
  console.log("-".repeat(100));
  const migrados = [];
  const caidos = [];
  for (const host of HOSTS) {
    const r = await checar(host);
    const prov = detectProvider("https://" + host + "/x") || "-";
    let obs = "";
    if (r.erro) {
      obs = r.provavelmenteMorto
        ? ">>> HOST CAIDO (DNS resolve, conexao nao fecha): " + r.erro
        : "sem conexao daqui: " + r.erro;
      if (r.provavelmenteMorto) caidos.push(host);
    }
    else if (r.redirecionaPara) {
      obs = ">>> REDIRECIONA PARA " + r.redirecionaPara;
      const como = ehReconhecido(r.redirecionaPara);
      if (!como) obs += "  (destino NAO reconhecido!)";
      migrados.push({ host, destino: r.redirecionaPara, reconhecido: como });
    } else if (r.status >= 400) obs = "sem resposta util";
    console.log(host.slice(0, 34).padEnd(36) + String(r.status).padEnd(7) + prov.padEnd(16) + obs);
  }

  console.log("\n=== resumo ===");
  if (!migrados.length) console.log("nenhum outro provedor migrou de dominio");
  for (const m of migrados) {
    console.log(`${m.host} -> ${m.destino}   ${m.reconhecido ? "ja reconhecido (" + m.reconhecido + ")" : "PRECISA DE AJUSTE"}`);
  }
})();
