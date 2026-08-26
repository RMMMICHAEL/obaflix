/**
 * Procura, no catálogo real, os casos que a matriz ainda não exercitou:
 * fonte `locked`, `audio_type` legendado e legendas externas.
 *
 * Amostra o catálogo com orçamento fixo de chamadas — não varre tudo. Não baixa
 * conteúdo e não abre sessão de reprodução (`/videos` não cria session_id).
 *
 * Uso:  npx tsx scripts/achar-casos-webcine.ts [--orcamento 40]
 */

export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

const BASE = process.env.WEBCINE_API_BASE ?? "https://utxptx-api.b-cdn.net/api/v1";
const SITE = "https://webcinevs2.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

let token = "";
let gastas = 0;

const cab = () => ({
  Accept: "application/json",
  Origin: SITE,
  Referer: SITE + "/",
  "User-Agent": UA,
  "x-device-id": process.env.WEBCINE_DEVICE_ID ?? "",
  Authorization: `Bearer ${token}`,
});

async function api(caminho: string): Promise<any | null> {
  gastas++;
  try {
    const r = await fetch(`${BASE}/${caminho}`, { headers: cab(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function autenticar() {
  const r = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      Origin: SITE, Referer: SITE + "/", "User-Agent": UA,
      "x-device-id": process.env.WEBCINE_DEVICE_ID ?? "",
    },
    body: JSON.stringify({ refresh_token: process.env.WEBCINE_REFRESH_TOKEN }),
    signal: AbortSignal.timeout(15000),
  });
  token = (await r.json()).token;
  return r.status;
}

const ENDPOINT: Record<string, string> = { movie: "movies", series: "series", anime: "animes" };

type Achado = {
  titulo: string;
  tipo: string;
  tmdbId: string | number;
  temporada?: number;
  episodio?: number;
  audios: string[];
  locked: number;
  code: number;
  premium: number;
  legendas: number;
};

(async () => {
  const arg = process.argv.indexOf("--orcamento");
  const ORCAMENTO = arg >= 0 ? Number(process.argv[arg + 1]) : 40;

  console.log("auth:", await autenticar());

  // Pool de candidatos: tendências + buscas onde legendado costuma aparecer.
  const pool: Array<{ id: number; type: string; title: string }> = [];
  const juntar = (lista: any[]) => {
    for (const it of lista ?? []) {
      if (it?.id && it?.type && !pool.some((p) => p.id === it.id && p.type === it.type)) {
        pool.push({ id: it.id, type: it.type, title: it.title ?? "" });
      }
    }
  };

  juntar((await api("search/trending"))?.data ?? []);
  for (const termo of ["anime", "legendado", "one piece", "naruto", "demon slayer", "attack on titan"]) {
    if (gastas >= ORCAMENTO / 2) break;
    juntar((await api(`search?q=${encodeURIComponent(termo)}&page=1&per_page=24`))?.data ?? []);
  }
  console.log(`pool: ${pool.length} títulos | chamadas gastas: ${gastas}`);

  const achados: Achado[] = [];
  const querLocked = () => !achados.some((a) => a.locked > 0);
  const querLegendado = () => !achados.some((a) => a.audios.some((x) => !/dub/i.test(x)));
  const querLegendas = () => !achados.some((a) => a.legendas > 0);

  for (const c of pool) {
    if (gastas >= ORCAMENTO) break;
    if (!querLocked() && !querLegendado() && !querLegendas()) break;

    const endpoint = ENDPOINT[String(c.type).toLowerCase()];
    if (!endpoint) continue;

    const det = await api(`${endpoint}/${c.id}?profile_id=${process.env.WEBCINE_PROFILE_ID}`);
    if (!det) continue;

    let alvo: string;
    let temporada: number | undefined;
    let episodio: number | undefined;
    if (endpoint === "movies") {
      alvo = `streaming/movies/${c.id}/videos?platform=web&device_type=web`;
    } else {
      const s1 = (det.seasons ?? [])[0];
      const ep = (s1?.episodes ?? [])[0];
      if (!ep) continue;
      temporada = s1.number;
      episodio = ep.number;
      alvo = `streaming/episodes/${ep.id}/videos?platform=web&device_type=web`;
    }

    const v = await api(alvo);
    if (!v?.videos?.length) continue;

    const a: Achado = {
      titulo: (det.title ?? c.title ?? "?").slice(0, 34),
      tipo: c.type,
      tmdbId: det.tmdb_id ?? "?",
      temporada, episodio,
      audios: [...new Set(v.videos.map((x: any) => String(x.audio_type)))] as string[],
      locked: v.videos.filter((x: any) => x.locked).length,
      code: v.videos.filter((x: any) => x.is_code).length,
      premium: v.videos.filter((x: any) => x.is_premium).length,
      legendas: (v.subtitles ?? []).length,
    };

    const interessa =
      (querLocked() && a.locked > 0) ||
      (querLegendado() && a.audios.some((x) => !/dub/i.test(x))) ||
      (querLegendas() && a.legendas > 0);

    if (interessa) {
      achados.push(a);
      console.log(
        `  ACHADO  ${a.tipo.padEnd(7)} ${a.titulo.padEnd(36)} tmdb=${String(a.tmdbId).padEnd(8)} ` +
        `audios=[${a.audios.join(",")}] locked=${a.locked} code=${a.code} premium=${a.premium} legendas=${a.legendas}` +
        (a.temporada ? `  (T${a.temporada}E${a.episodio})` : ""),
      );
    }
  }

  console.log(`\nchamadas usadas: ${gastas}/${ORCAMENTO}`);
  console.log("\nfaltando ainda:");
  console.log("  locked ...........:", querLocked() ? "NÃO ENCONTRADO" : "ok");
  console.log("  audio legendado ..:", querLegendado() ? "NÃO ENCONTRADO" : "ok");
  console.log("  legendas externas :", querLegendas() ? "NÃO ENCONTRADO" : "ok");

  if (achados.length) {
    console.log("\npara rodar na matriz, adicione em scripts/matriz-webcine.ts:");
    for (const a of achados) {
      const t = a.tipo === "movie" ? "movie" : "tv";
      console.log(
        `  { rotulo: "${a.tipo.toUpperCase()}  ${a.titulo}", tmdbId: "${a.tmdbId}", type: "${t}"` +
        (a.temporada ? `, season: ${a.temporada}, episode: ${a.episodio}` : "") +
        `, titleHint: "${a.titulo}" },`,
      );
    }
  }
})();
