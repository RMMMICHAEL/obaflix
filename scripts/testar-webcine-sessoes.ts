/**
 * Descobre se o `max_screens` do webcine limita SESSÃO ou APARELHO.
 *
 * É a pergunta que decide se um único device-id compartilhado atende todos os
 * usuários do Obaflix ou só dois de cada vez. O teste abre sessões em sequência
 * com o MESMO device-id e observa onde a API começa a recusar.
 *
 * Segurança:
 *   - device-id e profile-id vêm de .env.local, nunca do código, e não são
 *     impressos em lugar nenhum.
 *   - toda sessão aberta é fechada no fim, inclusive se der erro no meio. Sem
 *     isso a conta ficaria com telas ocupadas até o timeout do servidor.
 *   - o conteúdo não é baixado: a mídia só é tocada com uma requisição de 1 byte.
 *
 * Uso:
 *   npx tsx scripts/testar-webcine-sessoes.ts --episodio 120910
 *   npx tsx scripts/testar-webcine-sessoes.ts --episodio 120910 --sessoes 5
 *   npx tsx scripts/testar-webcine-sessoes.ts --episodio 120910 --resolver
 */

// Arquivo isolado: sem isto os scripts compartilham escopo global no tsc.
export {};

const BASE = process.env.WEBCINE_API_BASE ?? "https://utxptx-api.b-cdn.net/api/v1";
const SITE = process.env.WEBCINE_SITE ?? "https://webcinevs2.com";
const DEVICE_ID = process.env.WEBCINE_DEVICE_ID ?? "";
const PROFILE_ID = process.env.WEBCINE_PROFILE_ID ?? "";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36";

const cabecalhos = (extra: Record<string, string> = {}) => ({
  Accept: "application/json",
  Origin: SITE,
  Referer: SITE + "/",
  "User-Agent": UA,
  "x-device-id": DEVICE_ID,
  ...extra,
});

/** Esconde token, uuid e nome de arquivo antes de qualquer impressão. */
function limpar(texto: string): string {
  return texto
    .replace(/(bcdn_token=)[^&]+/gi, "$1<TOKEN>")
    .replace(/(cnvs_token=)[^&"]+/gi, "$1<TOKEN>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
}

async function api(caminho: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/${caminho}`, {
    ...init,
    headers: cabecalhos(init.headers as Record<string, string>),
    signal: AbortSignal.timeout(15000),
  });
  const texto = await res.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* resposta não-JSON */ }
  return { status: res.status, json, texto };
}

async function encerrar(sessionId: number | string) {
  try {
    const r = await api("streaming/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, session_id: sessionId }),
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

(async () => {
  const args = process.argv.slice(2);
  const valor = (nome: string) => {
    const i = args.indexOf(`--${nome}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const episodio = valor("episodio");
  const alvoSessoes = Number(valor("sessoes") ?? 4);
  const resolver = args.includes("--resolver");

  if (!DEVICE_ID || !PROFILE_ID) {
    console.error("Faltam WEBCINE_DEVICE_ID e WEBCINE_PROFILE_ID em .env.local.");
    console.error("São os mesmos valores que o seu navegador já usa no webcinevs2.com.");
    process.exit(1);
  }
  if (!episodio) {
    console.error("uso: npx tsx scripts/testar-webcine-sessoes.ts --episodio <id> [--sessoes N] [--resolver]");
    process.exit(1);
  }

  // 1. Lista os servidores do episódio.
  const videos = await api(`streaming/episodes/${episodio}/videos?platform=web&device_type=web`);
  if (videos.status !== 200) {
    console.error(`/videos respondeu ${videos.status}. ` +
      (videos.status === 401 ? "device-id inválido ou expirado." : limpar(videos.texto).slice(0, 200)));
    process.exit(1);
  }
  const lista = videos.json?.videos ?? [];
  console.log(`episódio ${episodio}: ${lista.length} servidor(es), assinatura=${videos.json?.has_subscription}`);
  if (!lista.length) { console.error("Nenhum servidor disponível."); process.exit(1); }
  const videoId = lista[0].id;

  // 2. Abre sessões em sequência, SEM encerrar, para achar o teto.
  const abertas: number[] = [];
  let veredito = "";
  console.log(`\nabrindo até ${alvoSessoes} sessões com o MESMO device-id...\n`);

  try {
    for (let i = 1; i <= alvoSessoes; i++) {
      const q = new URLSearchParams({
        device_id: DEVICE_ID,
        profile_id: PROFILE_ID,
        device_name: `Teste ${i} (Web)`,
        device_type: "web",
        platform: "web",
      });
      const r = await api(`streaming/episodes/${episodio}/video/${videoId}?${q}`);
      const sid = r.json?.session_id;

      if (r.status === 200 && sid) {
        abertas.push(sid);
        console.log(`  sessão ${i}: OK        (session_id=${sid})`);
      } else {
        const msg = r.json?.message ?? limpar(r.texto).slice(0, 120);
        console.log(`  sessão ${i}: RECUSADA  http=${r.status} — ${msg}`);
        veredito = `limite atingido na ${i}ª sessão simultânea`;
        break;
      }
    }

    console.log("");
    if (!veredito) {
      veredito = `${abertas.length} sessões simultâneas aceitas sem recusa`;
    }
    console.log("VEREDITO: " + veredito);
    console.log(
      abertas.length > 2
        ? "  → max_screens NÃO está limitando por sessão neste caminho.\n" +
          "    Um device-id compartilhado pode atender mais de 2 usuários."
        : "  → o limite de 2 telas vale por SESSÃO.\n" +
          "    Um device-id compartilhado atende 2 usuários simultâneos, e o 3º é recusado.",
    );

    // 3. Opcional: resolve uma URL e mostra o TTL, sem baixar o conteúdo.
    if (resolver && abertas.length) {
      const q = new URLSearchParams({
        device_id: DEVICE_ID, profile_id: PROFILE_ID,
        device_name: "Teste (Web)", device_type: "web", platform: "web",
      });
      const v = await api(`streaming/episodes/${episodio}/video/${videoId}?${q}`);
      if (v.json?.session_id) abertas.push(v.json.session_id);
      const payload = v.json?.video_url;
      if (payload) {
        const rr = await api("streaming/resolve-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload }),
        });
        const url: string = rr.json?.url ?? "";
        if (url) {
          const exp = Number(url.match(/expires=(\d+)/)?.[1] ?? 0);
          console.log("\nURL resolvida:");
          console.log("  host ....:", new URL(url).hostname);
          console.log("  formato .:", /\.m3u8/.test(url) ? "HLS" : /\.(mp4|mkv)/i.test(url) ? "MP4/MKV" : "?");
          if (exp) console.log("  TTL .....:", Math.round((exp - Date.now() / 1000) / 60), "minutos");
          console.log("\n  Para testar amarração por IP, abra ESTA url no celular usando dados móveis");
          console.log("  (rede diferente). Se tocar, o token não é preso ao IP de quem resolveu:");
          console.log("\n" + url + "\n");
          console.log("  (não compartilhe essa url — ela dá acesso ao arquivo até expirar)");
        }
      }
    }
  } finally {
    // Cleanup obrigatório: sessão aberta segura tela até o servidor expirar.
    if (abertas.length) {
      console.log(`\nencerrando ${abertas.length} sessão(ões)...`);
      const ok = await Promise.all(abertas.map(encerrar));
      console.log(`  fechadas: ${ok.filter(Boolean).length}/${abertas.length}`);
      if (ok.some((x) => !x)) {
        console.log("  ATENÇÃO: alguma sessão não fechou. Ela expira sozinha, mas até lá ocupa tela.");
      }
    }
  }
})();
