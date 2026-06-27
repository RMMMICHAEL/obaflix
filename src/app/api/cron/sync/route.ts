export const dynamic = "force-dynamic";
export const maxDuration = 300; // Pro plan: 5 min

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const APP = "https://app.megafrixapi.com/4.6.2";
const UA  = "okhttp/4.9.3";
const DELAY = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchApp(path: string, body?: string): Promise<string> {
  const r = await fetch(`${APP}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return r.text();
}

async function fetchWarez2(itemId: string, seasonNum?: number, episodeNum?: number) {
  try {
    const params = new URLSearchParams({ item_id: itemId });
    if (seasonNum != null) params.append("season_num", String(seasonNum));
    if (episodeNum != null) params.append("episode_num", String(episodeNum));
    const r = await fetch(`https://megafrixapi.com/iptv/warez2.php?${params}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { br: [], eng: [] };
    const data = await r.json().catch(() => null);
    return { br: (data?.br ?? []) as string[], eng: (data?.eng ?? []) as string[] };
  } catch {
    return { br: [], eng: [] };
  }
}

function mergeUrls(warezUrls: string[], htmlUrl: string | null): string | null {
  const all = [...warezUrls];
  if (htmlUrl && !all.includes(htmlUrl)) all.push(htmlUrl);
  return all.length > 0 ? all.join(",") : null;
}

// ── Parsers (mesmos do sync-app.ts) ─────────────────────────────────────────

function section(html: string, from: string, to: string) {
  const s = html.indexOf(from);
  if (s === -1) return "";
  const e = html.indexOf(to, s + from.length);
  return html.slice(s, e === -1 ? html.length : e);
}

function parseUltimosFilmes(html: string): string[] {
  return [...section(html, "Últimos Filmes", "Últimas Séries").matchAll(/openMovie\((\d+)\)/g)].map((m) => m[1]);
}
function parseUltimasSeries(html: string): string[] {
  return [...section(html, "Últimas Séries", "Episodios Recentes").matchAll(/openMovie\((\d+)\)/g)].map((m) => m[1]);
}
function parseEpsRecentes(html: string): Array<{ serieId: string; temp: number; ep: number }> {
  const sec = section(html, "Episodios Recentes", "Coleções");
  return [...sec.matchAll(/openMovie\((\d+)\)[\s\S]*?class="ano">\s*(\d+)x(\d+)/g)].map((m) => ({
    serieId: m[1],
    temp: Number(m[2]),
    ep: Number(m[3]),
  }));
}

function parseItem(html: string) {
  const str = (k: string) => html.match(new RegExp(`${k}:\\s*["\`]([^"\`]+)["\`]`))?.[1] ?? null;
  const num = (k: string) => html.match(new RegExp(`${k}:\\s*([\\d.]+)`))?.[1] ?? null;
  const b64 = html.match(/title:\s*atob\("([^"]+)"\)/)?.[1];
  const title = b64 ? Buffer.from(b64, "base64").toString() : (str("title") ?? null);
  const poster = str("poster")?.replace("https://d1muf25xaso8hp.cloudfront.net/", "") ?? null;
  const opts = html.match(/openOptions\(\{\s*br:\s*'([^']*)'\s*,\s*eng:\s*'([^']*)'/);
  return {
    id: num("id"),
    tmdb: str("tmdb"),
    title,
    poster,
    sinopse: html.match(/<span class="sinopse-text">\s*([\s\S]*?)\s*<\/span>/)?.[1]?.trim() ?? null,
    ano: html.match(/<span>Ano:<\/span>\s*<span>(\d{4})<\/span>/)?.[1] ?? null,
    nota: html.match(/<span>Nota:<\/span>\s*<span>([\d.]+)<\/span>/)?.[1] ?? null,
    duracaoMin: html.match(/<span>Duração:<\/span>\s*<span>(\d+)/)?.[1] ?? null,
    temporadas: html.match(/openEpisodes\((\d+)\)/)?.[1] ?? null,
    urlBR: opts?.[1]?.split(",")[0]?.trim() || null,
    urlENG: opts?.[2]?.split(",")[0]?.trim() || null,
  };
}

function parseEpisodes(html: string) {
  return [...html.matchAll(/data-episode='({[^']+})'/g)].flatMap((m) => {
    try {
      const d = JSON.parse(m[1]);
      return [{
        ep: Number(d.episode.episode_num),
        temp: Number(d.episode.season_num),
        titulo: d.episode.title ?? null,
        urlDub: d.br?.split(",")[0]?.trim() || null,
        urlLeg: d.eng?.split(",")[0]?.trim() || null,
      }];
    } catch {
      return [];
    }
  });
}

// ── Sync logic ────────────────────────────────────────────────────────────────

async function syncFilme(id: string, log: string[]): Promise<boolean> {
  const exists = await prisma.filme.findUnique({ where: { id }, select: { id: true } });
  if (exists) return false;

  const html = await fetchApp(`?page=viewItem&id=${id}`);
  const item = parseItem(html);
  if (!item.id || !item.title) return false;

  const warez = await fetchWarez2(item.id);
  const urlDub = mergeUrls(warez.br, item.urlBR);
  const urlLeg = mergeUrls(warez.eng, item.urlENG);

  await prisma.filme.upsert({
    where: { id: item.id },
    update: { urlDub: urlDub ?? undefined, urlLeg: urlLeg ?? undefined },
    create: {
      id: item.id,
      titulo: item.title,
      poster: item.poster,
      tmdbId: item.tmdb,
      ano: item.ano ? Number(item.ano) : null,
      nota: item.nota ? Number(item.nota) : null,
      duracao: item.duracaoMin ? Number(item.duracaoMin) : null,
      sinopse: item.sinopse,
      urlDub,
      urlLeg,
    },
  });

  log.push(`🎬 ${item.title}`);
  return true;
}

async function syncSerie(id: string, novosEpsAlvo: Array<{ temp: number; ep: number }>, log: string[]): Promise<number> {
  const html = await fetchApp(`?page=viewItem&id=${id}`);
  const item = parseItem(html);
  if (!item.id || !item.title) return 0;

  const jaExiste = await prisma.serie.findUnique({ where: { id }, select: { id: true } });

  await prisma.serie.upsert({
    where: { id: item.id },
    update: {},
    create: {
      id: item.id,
      titulo: item.title,
      poster: item.poster,
      tmdbId: item.tmdb,
      ano: item.ano ? Number(item.ano) : null,
      nota: item.nota ? Number(item.nota) : null,
      temporadas: item.temporadas ? Number(item.temporadas) : null,
      sinopse: item.sinopse,
      tipo: "serie",
    },
  });

  const tempCount = Number(item.temporadas ?? 1);
  const tempsParaBuscar = jaExiste
    ? [...new Set(novosEpsAlvo.map((e) => e.temp))]
    : Array.from({ length: tempCount }, (_, i) => i + 1);

  let totalEps = 0;
  for (const t of tempsParaBuscar) {
    await sleep(DELAY);
    const epsHtml = await fetchApp(`?page=getEpisodes`, `item=${item.id}&season=${t}&userEpisodes=[]`);
    const eps = parseEpisodes(epsHtml);

    for (const e of eps) {
      await prisma.episodio.upsert({
        where: { serieId_temporada_numeroEp: { serieId: item.id!, temporada: e.temp, numeroEp: e.ep } },
        update: { urlDub: e.urlDub ?? undefined, urlLeg: e.urlLeg ?? undefined },
        create: {
          id: `${item.id}-t${e.temp}e${e.ep}`,
          serieId: item.id!,
          temporada: e.temp,
          numeroEp: e.ep,
          titulo: e.titulo,
          urlDub: e.urlDub,
          urlLeg: e.urlLeg,
        },
      });
      totalEps++;
    }
  }

  log.push(`📺 ${item.title} (${jaExiste ? "atualizada" : "nova"}) — ${totalEps} eps`);
  return totalEps;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Vercel chama com Authorization: Bearer CRON_SECRET
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const startedAt = Date.now();
  const log: string[] = [];
  let totalFilmes = 0, totalSeries = 0, totalEps = 0;

  try {
    log.push("📡 Buscando viewHome...");
    const homeHtml = await fetchApp("?page=viewHome");

    const filmesIds   = parseUltimosFilmes(homeHtml);
    const seriesIds   = parseUltimasSeries(homeHtml);
    const epsRecentes = parseEpsRecentes(homeHtml);

    // Filmes novos: checa quais IDs ainda não existem no banco
    const filmesExist = new Set(
      (await prisma.filme.findMany({ where: { id: { in: filmesIds } }, select: { id: true } })).map((f) => f.id)
    );
    const novosFilmes = filmesIds.filter((id) => !filmesExist.has(id));

    // Séries: checa quais IDs já existem
    const seriesExist = new Set(
      (await prisma.serie.findMany({ where: { id: { in: seriesIds } }, select: { id: true } })).map((s) => s.id)
    );
    const novasSeries = seriesIds.filter((id) => !seriesExist.has(id));

    // Episódios recentes: checa quais já existem
    const novosEps = await Promise.all(
      epsRecentes.map(async (e) => {
        const exists = await prisma.episodio.findUnique({
          where: { serieId_temporada_numeroEp: { serieId: e.serieId, temporada: e.temp, numeroEp: e.ep } },
          select: { id: true },
        });
        return exists ? null : e;
      })
    ).then((arr) => arr.filter(Boolean) as typeof epsRecentes);

    log.push(`📋 Novidades: ${novosFilmes.length} filmes | ${novasSeries.length} séries | ${novosEps.length} eps recentes`);

    // ── Filmes ────────────────────────────────────────────────────────────────
    for (const id of novosFilmes) {
      await sleep(DELAY);
      const added = await syncFilme(id, log);
      if (added) totalFilmes++;
    }

    // ── Séries novas ──────────────────────────────────────────────────────────
    for (const id of novasSeries) {
      await sleep(DELAY);
      const eps = await syncSerie(id, [], log);
      totalSeries++;
      totalEps += eps;
    }

    // ── Episódios recentes de séries existentes ───────────────────────────────
    // Agrupa por serieId para minimizar chamadas à API
    const epsPorSerie = new Map<string, Array<{ temp: number; ep: number }>>();
    for (const e of novosEps) {
      if (novasSeries.includes(e.serieId)) continue; // já processado acima
      const arr = epsPorSerie.get(e.serieId) ?? [];
      arr.push({ temp: e.temp, ep: e.ep });
      epsPorSerie.set(e.serieId, arr);
    }

    for (const [serieId, eps] of epsPorSerie) {
      await sleep(DELAY);
      const added = await syncSerie(serieId, eps, log);
      totalEps += added;
    }

  } catch (err: any) {
    log.push(`❌ Erro: ${err.message}`);
    return NextResponse.json({ ok: false, log, error: err.message }, { status: 500 });
  } finally {
    await prisma.$disconnect();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.push(`✅ Concluído em ${elapsed}s — filmes: ${totalFilmes} | séries: ${totalSeries} | eps: ${totalEps}`);

  return NextResponse.json({ ok: true, totalFilmes, totalSeries, totalEps, elapsed, log });
}
