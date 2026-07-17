/**
 * reorganize-top250.ts
 * Reorganiza o Top 250 Filmes / Top 250 Séries do catálogo a partir de uma
 * lista extraída manualmente do IMDb (rank, título, nota, IMDb ID) — não faz
 * nenhum scraping automatizado, só processa um arquivo já baixado pelo usuário.
 *
 * Script pontual (roda quando o usuário traz uma lista nova), não recorrente.
 *
 * Formato esperado do .txt:
 *   FILMES
 *   1. Título | Nota 9.3 | tt0111161
 *   ...
 *   SÉRIES
 *   1. Título | Nota 9.5 | tt0903747
 *   ...
 *
 * Uso:
 *   npx tsx scripts/reorganize-top250.ts "caminho/lista.txt"             # dry run
 *   npx tsx scripts/reorganize-top250.ts "caminho/lista.txt" --import     # grava
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "fs";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

// Ver mesmo comentário em backfill-scores.ts: AbortSignal.timeout() sob
// concorrência às vezes rejeita fora da cadeia de promises do fetch.
process.on("unhandledRejection", (reason) => {
  console.error(`\n⚠️  unhandledRejection ignorado (não derruba o processo): ${reason}`);
});

const prisma = new PrismaClient();

const args      = process.argv.slice(2);
const filePath  = args.find((a) => !a.startsWith("--"));
const DO_IMPORT = args.includes("--import");
const CONCURRENCY = 8;
const TMDB_KEY  = process.env.TMDB_API_KEY;
const BASE      = "https://api.themoviedb.org/3";
const FONTE     = "imdb";

interface ListItem { rank: number; titulo: string; nota: number | null; imdbId: string }

// ── Parse do .txt ─────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s.replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

function parseSection(block: string): ListItem[] {
  const items: ListItem[] = [];
  const re = /^(\d+)\.\s+(.+?)\s+\|\s+Nota\s+([\d.]+)\s+\|\s+(tt\d+)\s*$/;
  for (const line of block.split("\n")) {
    const m = re.exec(line.trim());
    if (!m) continue;
    items.push({
      rank: Number(m[1]),
      titulo: decodeEntities(m[2]),
      nota: Number(m[3]) || null,
      imdbId: m[4],
    });
  }
  return items;
}

function parseFile(text: string): { filmes: ListItem[]; series: ListItem[] } {
  const filmesStart = text.indexOf("\nFILMES");
  const seriesStart = text.indexOf("\nSÉRIES");
  const msgStart = text.indexOf("MENSAGEM PARA O PROGRAMADOR");
  if (filmesStart === -1 || seriesStart === -1) {
    throw new Error("Não encontrei as seções FILMES / SÉRIES no arquivo.");
  }
  const filmesBlock = text.slice(filmesStart, seriesStart);
  const seriesBlock = text.slice(seriesStart, msgStart === -1 ? undefined : msgStart);
  return { filmes: parseSection(filmesBlock), series: parseSection(seriesBlock) };
}

function findDuplicates(items: ListItem[]): string[] {
  const seen = new Map<string, number>();
  for (const it of items) seen.set(it.imdbId, (seen.get(it.imdbId) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

// ── TMDB helpers ──────────────────────────────────────────────────────────────

async function tmdbFetch(path: string): Promise<any | null> {
  // AbortController manual em vez de AbortSignal.timeout() — ver comentário
  // equivalente em backfill-scores.ts (bug do fetch nativo do Node/undici
  // sob concorrência: o timer interno derruba o processo com uma exceção
  // fora da cadeia de promises do fetch).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}&language=pt-BR`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function detectTipoSerie(generoIds: number[], originCountries: string[] | undefined): "anime" | "desenho" | "serie" {
  if (!generoIds.includes(16)) return "serie";
  return originCountries?.includes("JP") ? "anime" : "desenho";
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    }),
  );
}

// ── Plano de mudanças ─────────────────────────────────────────────────────────

interface RankUpdate { id: string; rank: number }
interface StubCreate {
  id: string; tmdbId: string; imdbId: string; rank: number;
  titulo: string; poster: string | null; background: string | null; sinopse: string | null;
  ano: number | null; nota: number | null; tipo?: "anime" | "desenho" | "serie";
  generos: { id: number; nome: string }[];
}

async function planTipo(
  tipo: "filme" | "serie",
  list: ListItem[],
): Promise<{ updates: RankUpdate[]; stubs: StubCreate[]; clears: string[]; tmdbMatched: number }> {
  const imdbIds = list.map((i) => i.imdbId);

  const existingByImdb = tipo === "filme"
    ? await prisma.filme.findMany({ where: { imdbId: { in: imdbIds } }, select: { id: true, imdbId: true } })
    : await prisma.serie.findMany({ where: { imdbId: { in: imdbIds } }, select: { id: true, imdbId: true } });
  const imdbMap = new Map(existingByImdb.map((r) => [r.imdbId!, r.id]));

  const currentlyRanked = tipo === "filme"
    ? await prisma.filme.findMany({ where: { top250: { not: null } }, select: { id: true, imdbId: true } })
    : await prisma.serie.findMany({ where: { top250: { not: null } }, select: { id: true, imdbId: true } });

  const updates: RankUpdate[] = [];
  const stubs: StubCreate[] = [];
  const matchedIds = new Set<string>(); // catalog ids que ficam rankeados após esta lista
  let tmdbMatched = 0;

  const unmatched = list.filter((it) => !imdbMap.has(it.imdbId));
  for (const it of list) {
    const id = imdbMap.get(it.imdbId);
    if (id) { updates.push({ id, rank: it.rank }); matchedIds.add(id); }
  }

  // Itens sem match por imdbId: tenta achar por tmdbId (via /find) antes de criar stub
  await pool(unmatched, CONCURRENCY, async (it) => {
    const found = await tmdbFetch(`/find/${it.imdbId}?external_source=imdb_id`);
    const hit = tipo === "filme" ? found?.movie_results?.[0] : found?.tv_results?.[0];
    if (!hit?.id) return; // não achou nem no TMDB — fica de fora, sem stub

    const byTmdb = tipo === "filme"
      ? await prisma.filme.findFirst({ where: { tmdbId: String(hit.id) }, select: { id: true } })
      : await prisma.serie.findFirst({ where: { tmdbId: String(hit.id) }, select: { id: true } });

    if (byTmdb) {
      // já existe no catálogo (importado sem imdbId ainda) — atualiza em vez de duplicar
      updates.push({ id: byTmdb.id, rank: it.rank });
      matchedIds.add(byTmdb.id);
      tmdbMatched++;
      // grava o imdbId nele também (fora do batch de rank, update simples)
      if (DO_IMPORT) {
        if (tipo === "filme") await prisma.filme.update({ where: { id: byTmdb.id }, data: { imdbId: it.imdbId } }).catch(() => {});
        else await prisma.serie.update({ where: { id: byTmdb.id }, data: { imdbId: it.imdbId } }).catch(() => {});
      }
      return;
    }

    // Não existe de jeito nenhum — cria stub sem player
    const details = await tmdbFetch(tipo === "filme" ? `/movie/${hit.id}` : `/tv/${hit.id}`);
    if (!details?.id) return;

    const generos: { id: number; nome: string }[] = (details.genres ?? []).map((g: any) => ({ id: g.id, nome: g.name }));
    const stub: StubCreate = {
      id: `imdb_${it.imdbId}`,
      tmdbId: String(hit.id),
      imdbId: it.imdbId,
      rank: it.rank,
      titulo: details.title ?? details.name ?? it.titulo,
      poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
      background: details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : null,
      sinopse: details.overview ?? null,
      ano: (details.release_date ?? details.first_air_date ?? "").slice(0, 4) ? Number((details.release_date ?? details.first_air_date).slice(0, 4)) : null,
      nota: typeof details.vote_average === "number" ? details.vote_average : it.nota,
      generos,
    };
    if (tipo === "serie") {
      stub.tipo = detectTipoSerie(generos.map((g) => g.id), details.origin_country);
    }
    stubs.push(stub);
    matchedIds.add(stub.id);
  });

  // Estava rankeado antes, não está mais na lista nova → limpa o rank (mantém a linha)
  const clears = currentlyRanked.filter((r) => !matchedIds.has(r.id)).map((r) => r.id);

  return { updates, stubs, clears, tmdbMatched };
}

// ── Execução ──────────────────────────────────────────────────────────────────

async function applyPlan(
  tipo: "filme" | "serie",
  updates: RankUpdate[],
  stubs: StubCreate[],
  clears: string[],
) {
  if (!DO_IMPORT) return;

  if (updates.length > 0) {
    const rows = updates.map((u) => Prisma.sql`(${u.id}::text, ${u.rank}::int4)`);
    if (tipo === "filme") {
      await prisma.$executeRaw`
        UPDATE "Filme" AS t SET top250 = v.rank, "top250Fonte" = ${FONTE}, "top250AtualizadoEm" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank) WHERE t.id = v.id`;
    } else {
      await prisma.$executeRaw`
        UPDATE "Serie" AS t SET top250 = v.rank, "top250Fonte" = ${FONTE}, "top250AtualizadoEm" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank) WHERE t.id = v.id`;
    }
  }

  if (clears.length > 0) {
    if (tipo === "filme") await prisma.filme.updateMany({ where: { id: { in: clears } }, data: { top250: null } });
    else await prisma.serie.updateMany({ where: { id: { in: clears } }, data: { top250: null } });
  }

  for (const s of stubs) {
    const genMap = new Map<number, string>();
    s.generos.forEach((g) => genMap.set(g.id, g.nome));
    if (genMap.size > 0) {
      await prisma.genero.createMany({
        data: [...genMap.entries()].map(([id, nome]) => ({ id, nome })),
        skipDuplicates: true,
      });
    }
    if (tipo === "filme") {
      await prisma.filme.create({
        data: {
          id: s.id, tmdbId: s.tmdbId, imdbId: s.imdbId, titulo: s.titulo,
          poster: s.poster, background: s.background, sinopse: s.sinopse,
          ano: s.ano, nota: s.nota, top250: s.rank, top250Fonte: FONTE, top250AtualizadoEm: new Date(),
          urlDub: null, urlLeg: null,
        },
      }).catch(() => {});
      if (s.generos.length > 0) {
        await prisma.filmeGenero.createMany({
          data: s.generos.map((g) => ({ filmeId: s.id, generoId: g.id })),
          skipDuplicates: true,
        });
      }
    } else {
      await prisma.serie.create({
        data: {
          id: s.id, tmdbId: s.tmdbId, imdbId: s.imdbId, titulo: s.titulo,
          poster: s.poster, background: s.background, sinopse: s.sinopse,
          ano: s.ano, nota: s.nota, top250: s.rank, top250Fonte: FONTE, top250AtualizadoEm: new Date(),
          tipo: s.tipo ?? "serie",
        },
      }).catch(() => {});
      if (s.generos.length > 0) {
        await prisma.serieGenero.createMany({
          data: s.generos.map((g) => ({ serieId: s.id, generoId: g.id })),
          skipDuplicates: true,
        });
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!filePath) {
    console.error("❌ Uso: npx tsx scripts/reorganize-top250.ts \"caminho/lista.txt\" [--import]");
    process.exit(1);
  }
  if (!TMDB_KEY) {
    console.error("❌ TMDB_API_KEY não configurado no ambiente.");
    process.exit(1);
  }

  console.log("══════════════════════════════════════════");
  console.log("   Reorganização Top 250 (fonte: IMDb)");
  console.log(`   Modo: ${DO_IMPORT ? "IMPORT" : "DRY RUN"}`);
  console.log("══════════════════════════════════════════");
  if (!DO_IMPORT) console.log("\nSem --import, nada é salvo.\n");

  const text = readFileSync(filePath, "utf-8");
  const { filmes, series } = parseFile(text);
  console.log(`📄 Lidos: ${filmes.length} filmes | ${series.length} séries`);

  const dupFilmes = findDuplicates(filmes);
  const dupSeries = findDuplicates(series);
  if (dupFilmes.length) console.log(`⚠️  IMDb IDs duplicados em FILMES: ${dupFilmes.join(", ")}`);
  if (dupSeries.length) console.log(`⚠️  IMDb IDs duplicados em SÉRIES: ${dupSeries.join(", ")}`);

  console.log("\n🎬 Processando filmes...");
  const pf = await planTipo("filme", filmes);
  console.log(`   Match direto por imdbId: ${pf.updates.length - pf.tmdbMatched} | match por tmdbId (imdbId preenchido agora): ${pf.tmdbMatched} | novos stubs sem player: ${pf.stubs.length} | removidos do ranking: ${pf.clears.length}`);
  await applyPlan("filme", pf.updates, pf.stubs, pf.clears);

  console.log("\n📺 Processando séries...");
  const ps = await planTipo("serie", series);
  console.log(`   Match direto por imdbId: ${ps.updates.length - ps.tmdbMatched} | match por tmdbId (imdbId preenchido agora): ${ps.tmdbMatched} | novos stubs sem player: ${ps.stubs.length} | removidos do ranking: ${ps.clears.length}`);
  await applyPlan("serie", ps.updates, ps.stubs, ps.clears);

  console.log(`\n✅ Concluído${DO_IMPORT ? "" : " (dry-run — rode de novo com --import pra gravar)"}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
