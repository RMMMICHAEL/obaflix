/**
 * Sincroniza conteúdo recente do Megaflix App → Obaflix
 * Uso: npx tsx scripts/sync-app.ts
 * Flags: --filmes  --series  --all (default: --all)
 *        --paginas=5  (quantas páginas do viewHome buscar, default 3)
 */

const APP = "https://app.megafrixapi.com/4.6.2";
const OBAFLIX = process.env.OBAFLIX_URL ?? "https://obaflix.vercel.app";
const TOKEN = process.env.ADMIN_SECRET_TOKEN ?? "@Oba152535";
const UA = "okhttp/4.9.3";
const DELAY_MS = 400;

const args = process.argv.slice(2);
const SYNC_FILMES = args.includes("--filmes") || args.includes("--all") || args.length === 0;
const SYNC_SERIES = args.includes("--series") || args.includes("--all") || args.length === 0;
const PAGINAS = Number(args.find(a => a.startsWith("--paginas="))?.split("=")[1] ?? 3);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseItem(html: string) {
  const get = (key: string) => html.match(new RegExp(`${key}:\\s*["\`]([^"\`]+)["\`]`))?.[1] ?? null;
  const getNum = (key: string) => html.match(new RegExp(`${key}:\\s*([\\d.]+)`))?.[1] ?? null;

  const id = getNum("id");
  const tmdb = get("tmdb");
  const imdb = get("imdb_id");
  const posterRaw = get("poster");
  const movie = html.includes("movie: true");

  // title pode ser atob("...") ou string normal
  const titleB64 = html.match(/title:\s*atob\("([^"]+)"\)/)?.[1];
  const titleRaw = html.match(/title:\s*"([^"]+)"/)?.[1];
  const title = titleB64
    ? Buffer.from(titleB64, "base64").toString("utf-8")
    : (titleRaw ?? null);

  const poster = posterRaw?.replace("https://d1muf25xaso8hp.cloudfront.net/", "") ?? null;

  // Metadados do HTML
  const sinopse = html.match(/<span class="sinopse-text">\s*([\s\S]*?)\s*<\/span>/)?.[1]?.trim() ?? null;
  const ano = html.match(/<span>Ano:<\/span>\s*<span>(\d{4})<\/span>/)?.[1] ?? null;
  const nota = html.match(/<span>Nota:<\/span>\s*<span>([\d.]+)<\/span>/)?.[1] ?? null;
  const duracaoMin = html.match(/<span>Duração:<\/span>\s*<span>(\d+)/)?.[1] ?? null;

  // Player URLs do openOptions (filmes)
  const optionsMatch = html.match(/openOptions\(\{\s*br:\s*'([^']*)'\s*,\s*eng:\s*'([^']*)'/);
  const urlBR = optionsMatch?.[1]?.split(",")[0]?.trim() || null;
  const urlENG = optionsMatch?.[2]?.split(",")[0]?.trim() || null;

  // Número de temporadas (séries)
  const temporadas = html.match(/openEpisodes\((\d+)\)/)?.[1] ?? null;

  return { id, tmdb, imdb, title, poster, sinopse, ano, nota, duracaoMin, urlBR, urlENG, movie, temporadas };
}

function parseEpisodes(html: string) {
  const eps: Array<{ ep: number; temp: number; titulo: string | null; urlDub: string | null; urlLeg: string | null }> = [];
  const matches = html.matchAll(/data-episode='({[^']+})'/g);
  for (const m of matches) {
    try {
      const d = JSON.parse(m[1]);
      eps.push({
        ep: Number(d.episode.episode_num),
        temp: Number(d.episode.season_num),
        titulo: d.episode.title ?? null,
        urlDub: d.br?.split(",")[0]?.trim() || null,
        urlLeg: d.eng?.split(",")[0]?.trim() || null,
      });
    } catch { /* skip malformed */ }
  }
  return eps;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchApp(path: string, body?: string): Promise<string> {
  const res = await fetch(`${APP}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
  });
  return res.text();
}

async function getRecentIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let p = 1; p <= PAGINAS; p++) {
    const html = await fetchApp("?page=viewHome");
    const matches = html.matchAll(/openMovie\((\d+)\)/g);
    for (const m of matches) ids.add(m[1]);
    await sleep(DELAY_MS);
  }
  return [...ids];
}

// ── Obaflix API ───────────────────────────────────────────────────────────────

async function obaFetch(path: string, body: object) {
  const res = await fetch(`${OBAFLIX}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function jaExisteFilme(id: string): Promise<boolean> {
  const res = await fetch(`${OBAFLIX}/api/admin/filme?q=${encodeURIComponent(id)}`, {
    headers: { "x-admin-token": TOKEN },
  });
  const d = await res.json().catch(() => ({ items: [] }));
  return d.items?.some((x: any) => x.id === id) ?? false;
}

async function jaExisteSerie(id: string): Promise<boolean> {
  const res = await fetch(`${OBAFLIX}/api/admin/serie?q=&page=1`, {
    headers: { "x-admin-token": TOKEN },
  });
  const d = await res.json().catch(() => ({ items: [] }));
  return d.items?.some((x: any) => x.id === id) ?? false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎬 Megaflix → Obaflix Sync`);
  console.log(`   App: ${APP} | Páginas: ${PAGINAS}`);
  console.log(`   Filmes: ${SYNC_FILMES} | Séries: ${SYNC_SERIES}\n`);

  const ids = await getRecentIds();
  console.log(`📋 ${ids.length} IDs encontrados no viewHome\n`);

  let filmesSincronizados = 0;
  let seriesSincronizadas = 0;
  let episodiosSincronizados = 0;
  let ignorados = 0;

  for (const id of ids) {
    await sleep(DELAY_MS);
    const html = await fetchApp(`?page=viewItem&id=${id}`);
    const item = parseItem(html);

    if (!item.id || !item.title) { ignorados++; continue; }

    // ── Filme ────────────────────────────────────────────────────────────────
    if (item.movie && SYNC_FILMES) {
      if (await jaExisteFilme(item.id)) {
        // Mesmo se já existe, atualiza URL se mudou
        if (item.urlBR || item.urlENG) {
          await obaFetch("/api/admin/filme", {
            id: item.id,
            titulo: item.title,
            poster: item.poster,
            tmdbId: item.tmdb,
            ano: item.ano ? Number(item.ano) : null,
            nota: item.nota ? Number(item.nota) : null,
            duracao: item.duracaoMin ? Number(item.duracaoMin) : null,
            sinopse: item.sinopse,
            urlDub: item.urlBR,
            urlLeg: item.urlENG || null,
          });
          console.log(`  ↻ Filme atualizado: ${item.title} (${item.id})`);
        }
        continue;
      }

      const r = await obaFetch("/api/admin/filme", {
        id: item.id,
        titulo: item.title,
        poster: item.poster,
        tmdbId: item.tmdb,
        ano: item.ano ? Number(item.ano) : null,
        nota: item.nota ? Number(item.nota) : null,
        duracao: item.duracaoMin ? Number(item.duracaoMin) : null,
        sinopse: item.sinopse,
        urlDub: item.urlBR,
        urlLeg: item.urlENG || null,
      });
      console.log(`  ✅ Filme: ${item.title} (${item.id}) →`, r);
      filmesSincronizados++;
    }

    // ── Série + Episódios ────────────────────────────────────────────────────
    else if (!item.movie && SYNC_SERIES) {
      // Upsert série
      await obaFetch("/api/admin/serie", {
        id: item.id,
        titulo: item.title,
        poster: item.poster,
        tmdbId: item.tmdb,
        ano: item.ano ? Number(item.ano) : null,
        nota: item.nota ? Number(item.nota) : null,
        temporadas: item.temporadas ? Number(item.temporadas) : null,
        sinopse: item.sinopse,
        tipo: "serie",
      });

      const tempCount = Number(item.temporadas ?? 1);
      const todosEps: Array<{ ep: number; temp: number; titulo: string | null; urlDub: string | null; urlLeg: string | null }> = [];

      for (let t = 1; t <= tempCount; t++) {
        await sleep(DELAY_MS);
        const epsHtml = await fetchApp(
          `?page=getEpisodes`,
          `item=${item.id}&season=${t}&userEpisodes=[]`
        );
        const eps = parseEpisodes(epsHtml);
        todosEps.push(...eps);
      }

      if (todosEps.length > 0) {
        const r: any = await obaFetch("/api/admin/episodio/bulk", {
          serieId: item.id,
          episodios: todosEps,
        });
        episodiosSincronizados += r.ok ?? 0;
        console.log(`  ✅ Série: ${item.title} — ${todosEps.length} eps (${item.temporadas} temp) →`, r);
      } else {
        console.log(`  ✅ Série: ${item.title} (sem eps ainda)`);
      }
      seriesSincronizadas++;
    }
  }

  console.log(`\n🎉 Concluído!`);
  console.log(`   Filmes: ${filmesSincronizados} | Séries: ${seriesSincronizadas} | Eps: ${episodiosSincronizados} | Ignorados: ${ignorados}`);
}

main().catch(console.error);
