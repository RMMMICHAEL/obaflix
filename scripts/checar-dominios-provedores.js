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
const { detectProvider } = require(path.join(__dirname, "..", "desktop/electron/extractors.js"));

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
    return { status: 0, erro: String(e.message || e).slice(0, 44) };
  }
}

(async () => {
  console.log("host".padEnd(36) + "HTTP".padEnd(7) + "detectProvider".padEnd(16) + "observacao");
  console.log("-".repeat(100));
  const migrados = [];
  for (const host of HOSTS) {
    const r = await checar(host);
    const prov = detectProvider("https://" + host + "/x") || "-";
    let obs = "";
    if (r.erro) obs = "ERRO " + r.erro;
    else if (r.redirecionaPara) {
      obs = ">>> REDIRECIONA PARA " + r.redirecionaPara;
      const provDestino = detectProvider("https://" + r.redirecionaPara + "/x");
      if (!provDestino) obs += "  (destino NAO reconhecido!)";
      migrados.push({ host, destino: r.redirecionaPara, reconhecido: !!provDestino });
    } else if (r.status >= 400) obs = "sem resposta util";
    console.log(host.slice(0, 34).padEnd(36) + String(r.status).padEnd(7) + prov.padEnd(16) + obs);
  }

  console.log("\n=== resumo ===");
  if (!migrados.length) console.log("nenhum outro provedor migrou de dominio");
  for (const m of migrados) {
    console.log(`${m.host} -> ${m.destino}   ${m.reconhecido ? "ja reconhecido" : "PRECISA DE AJUSTE"}`);
  }
})();
