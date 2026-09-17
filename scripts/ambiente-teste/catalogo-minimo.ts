/**
 * Catálogo MÍNIMO para o smoke, gravado SOMENTE no banco isolado de testes.
 *
 * O preparo do ambiente criou schema, planos, preços e contas, mas nenhum
 * filme ou série: a Home da TV abria só o layout. Este script copia poucos
 * títulos a partir das APIs PÚBLICAS de catálogo (as mesmas que qualquer
 * visitante lê, sem autenticação), com uma lista fechada de campos.
 *
 * Nunca grava URL de provedor: `urlDub`/`urlLeg` ficam nulos. As APIs públicas
 * nem as expõem (só "disponivel"). Consequências conhecidas:
 *   - filmes podem ter fontes pelo id/tmdbId (a rota de fontes não depende só do
 *     banco), a confirmar no smoke;
 *   - episódios aparecem como indisponíveis na TV;
 *   - a vitrine "Mais bem avaliados" fica vazia (exige URL no banco).
 *
 *   OBAFLIX_TESTE_ENV_FILE=<arquivo> npx tsx scripts/ambiente-teste/catalogo-minimo.ts --ambiente-id=<uuid>
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const ORIGEM_PUBLICA = "https://obaflix.online";
const FILMES = 8;
const SERIES = 4;
const EPISODIOS_POR_SERIE = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recusar(motivo: string): never {
  console.error(`RECUSADO: ${motivo}`);
  process.exit(3);
}

function lerVariaveis(): Record<string, string> {
  const caminho = process.env.OBAFLIX_TESTE_ENV_FILE;
  if (!caminho) recusar("defina OBAFLIX_TESTE_ENV_FILE");
  return Object.fromEntries(
    readFileSync(caminho, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
  );
}

async function publico<T>(caminho: string): Promise<T> {
  const r = await fetch(`${ORIGEM_PUBLICA}${caminho}`, { headers: { accept: "application/json" }, redirect: "error" });
  if (!r.ok) throw new Error(`GET publico ${caminho.split("?")[0]} -> ${r.status}`);
  return (await r.json()) as T;
}

type Genero = { id: number; nome: string };
type Midia = Record<string, unknown> & { id: string; generos?: { genero: Genero }[] };

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const inteiro = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const numero = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Artes vêm do TMDB; qualquer outro host não entra. */
const arte = (v: unknown) => {
  const t = texto(v);
  if (!t) return null;
  try { return new URL(t).hostname === "image.tmdb.org" ? t : null; } catch { return t.startsWith("/") ? t : null; }
};

async function main() {
  const id = process.argv.find((a) => a.startsWith("--ambiente-id="))?.split("=")[1];
  if (!id || !UUID.test(id)) recusar("--ambiente-id=<uuid> obrigatorio");
  const vars = lerVariaveis();
  const url = vars.OBAFLIX_TESTE_DATABASE_URL_UNPOOLED || vars.OBAFLIX_TESTE_DATABASE_URL;
  if (!url || !new URL(url).hostname.endsWith(".neon.tech")) recusar("URL nao e do Neon de teste");

  const db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const marcador = await db.$queryRawUnsafe<{ id: string; ambiente: string }[]>(`SELECT "id"::text AS id, "ambiente" FROM "_ObaflixAmbiente"`);
    if (marcador.length !== 1 || marcador[0].id !== id || marcador[0].ambiente !== "teste") recusar("marcador diferente do autorizado");

    const inicio = await publico<{ popularesFilmes: Midia[]; popularesSeries: Midia[] }>("/api/tv/home");
    const idsFilmes = inicio.popularesFilmes.slice(0, FILMES).map((f) => String(f.id));
    // Só séries que tenham episódios: série vazia não serve para o smoke.
    const candidatasSeries = inicio.popularesSeries.map((s) => String(s.id));

    const generos = new Map<number, string>();
    const agora = Date.now();
    let filmes = 0, series = 0, episodios = 0;

    for (const [posicao, fid] of idsFilmes.entries()) {
      const f = await publico<Midia>(`/api/filmes/${encodeURIComponent(fid)}`);
      const gs = (f.generos ?? []).map((g) => g.genero).filter((g) => Number.isInteger(g?.id) && texto(g?.nome));
      gs.forEach((g) => generos.set(g.id, g.nome));
      const dados = {
        tmdbId: texto(f.tmdbId), imdbId: texto(f.imdbId), titulo: texto(f.titulo) ?? "Sem título",
        tituloOriginal: texto(f.tituloOriginal), poster: arte(f.poster), background: arte(f.background), logo: arte(f.logo),
        sinopse: texto(f.sinopse), ano: inteiro(f.ano), nota: numero(f.nota), voteCount: inteiro(f.voteCount),
        popularidade: numero(f.popularidade), duracao: inteiro(f.duracao),
        popularRank: posicao + 1, createdAt: new Date(agora - posicao * 60_000),
        urlDub: null, urlLeg: null,
      };
      for (const g of gs) await db.genero.upsert({ where: { id: g.id }, create: { id: g.id, nome: g.nome }, update: { nome: g.nome } });
      await db.filme.upsert({ where: { id: fid }, create: { id: fid, ...dados }, update: dados });
      for (const g of gs) await db.filmeGenero.upsert({ where: { filmeId_generoId: { filmeId: fid, generoId: g.id } }, create: { filmeId: fid, generoId: g.id }, update: {} });
      filmes++;
    }

    for (const sid of candidatasSeries) {
      if (series >= SERIES) break;
      const posicao = series;
      // Menor temporada que existe: nem toda série tem episódios na temporada 1.
      const todos = await publico<Midia[]>(`/api/series/${encodeURIComponent(sid)}/episodios`);
      if (todos.length === 0) continue;
      const s = await publico<Midia>(`/api/series/${encodeURIComponent(sid)}`);
      const gs = (s.generos ?? []).map((g) => g.genero).filter((g) => Number.isInteger(g?.id) && texto(g?.nome));
      gs.forEach((g) => generos.set(g.id, g.nome));
      const temporadas = todos.map((e) => inteiro(e.temporada)).filter((t): t is number => t !== null);
      const primeira = temporadas.length ? Math.min(...temporadas) : null;
      const eps = todos
        .filter((e) => primeira !== null && inteiro(e.temporada) === primeira)
        .sort((a, b) => (inteiro(a.numeroEp) ?? 0) - (inteiro(b.numeroEp) ?? 0))
        .slice(0, EPISODIOS_POR_SERIE);
      const dados = {
        tmdbId: texto(s.tmdbId), imdbId: texto(s.imdbId), titulo: texto(s.titulo) ?? "Sem título",
        tituloOriginal: texto(s.tituloOriginal), poster: arte(s.poster), background: arte(s.background), logo: arte(s.logo),
        sinopse: texto(s.sinopse), ano: inteiro(s.ano), nota: numero(s.nota), voteCount: inteiro(s.voteCount),
        popularidade: numero(s.popularidade), temporadas: 1, tipo: "serie",
        popularRank: posicao + 1, createdAt: new Date(agora - posicao * 60_000),
      };
      for (const g of gs) await db.genero.upsert({ where: { id: g.id }, create: { id: g.id, nome: g.nome }, update: { nome: g.nome } });
      await db.serie.upsert({ where: { id: sid }, create: { id: sid, ...dados }, update: dados });
      for (const g of gs) await db.serieGenero.upsert({ where: { serieId_generoId: { serieId: sid, generoId: g.id } }, create: { serieId: sid, generoId: g.id }, update: {} });
      for (const e of eps) {
        const eid = texto(e.id);
        const temporada = inteiro(e.temporada), numeroEp = inteiro(e.numeroEp);
        if (!eid || temporada === null || numeroEp === null) continue;
        const d = { serieId: sid, temporada, numeroEp, titulo: texto(e.titulo), thumbnail: arte(e.thumbnail), urlDub: null, urlLeg: null };
        await db.episodio.upsert({ where: { id: eid }, create: { id: eid, ...d }, update: d });
        episodios++;
      }
      series++;
    }

    // Limpeza do próprio seed: série gravada antes sem nenhum episódio e sem
    // uso (histórico, lista) sai do banco de teste. Nada fora disso é apagado.
    const vazias = await db.serie.findMany({
      where: { episodios: { none: {} }, progresso: { none: {} }, watchlist: { none: {} } },
      select: { id: true },
    });
    for (const v of vazias) {
      await db.serieGenero.deleteMany({ where: { serieId: v.id } });
      await db.serie.delete({ where: { id: v.id } });
    }

    console.log(JSON.stringify({ gravado: "banco de teste", filmes, series, episodios, generos: generos.size, seriesVaziasRemovidas: vazias.length, urlsDeProvedor: 0 }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => { console.error(`ERRO: ${e instanceof Error ? e.message.split("\n")[0] : "falha"}`); process.exit(1); });
