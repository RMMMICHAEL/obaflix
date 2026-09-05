import { unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dedupeCanonical } from "@/lib/canonical";

/** Quantidade máxima usada pelas vitrines largas do catálogo. */
export const CATALOG_SHOWCASE_LIMIT = 24;

const catalogItemSelect = {
  id: true,
  // Criterio de deduplicacao, nunca conteudo de vitrine: sai antes do retorno.
  tmdbId: true,
  titulo: true,
  poster: true,
  background: true,
  logo: true,
  sinopse: true,
  ano: true,
  nota: true,
  top250: true,
  generos: { select: { genero: { select: { id: true, nome: true } } } },
} as const;

/**
 * A fonte única das vitrines "Mais Bem Avaliados".
 *
 * `top250Fonte = imdb` impede que um ranking antigo gerado por nota do TMDB
 * volte a entrar silenciosamente. O filtro de disponibilidade ocorre antes do
 * `take`, portanto títulos sem player não gastam posições da vitrine e a ordem
 * original do IMDb é preservada entre os títulos realmente disponíveis.
 */
export const getImdbTop250Showcases = unstable_cache(
  async () => {
    const [filmesRaw, series] = await Promise.all([
      prisma.filme.findMany({
        where: {
          top250Fonte: "imdb",
          top250: { not: null },
          OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
        },
        orderBy: [{ top250: "asc" }, { id: "asc" }],
        take: CATALOG_SHOWCASE_LIMIT,
        select: { ...catalogItemSelect, urlDub: true, urlLeg: true },
      }),
      prisma.serie.findMany({
        where: {
          tipo: "serie",
          top250Fonte: "imdb",
          top250: { not: null },
          episodios: {
            some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
          },
        },
        orderBy: [{ top250: "asc" }, { id: "asc" }],
        take: CATALOG_SHOWCASE_LIMIT,
        select: { ...catalogItemSelect, tipo: true },
      }),
    ]);

    // URLs de provedor nunca atravessam a fronteira desta função. As vitrines
    // recebem somente os booleanos necessários para desenhar DUB/LEG.
    //
    // A deduplicação canônica vem antes: `sync-top250` grava o mesmo rank em
    // toda linha com aquele tmdbId, então um título duplicado ocupava duas ou
    // três posições da vitrine — e o `take` acima já tinha gasto as vagas.
    const filmes = dedupeCanonical(
      filmesRaw.map(({ urlDub, urlLeg, ...filme }) => ({
        ...filme,
        tipo: "filme" as const,
        dub: Boolean(urlDub),
        leg: Boolean(urlLeg),
      })),
    ).map(({ tmdbId, ...filme }) => filme);

    const seriesSemDuplicata = dedupeCanonical(series).map(({ tmdbId, ...serie }) => serie);

    return { filmes, series: seriesSemDuplicata };
  },
  ["catalog-showcases-imdb-top250-v1"],
  { revalidate: 300, tags: ["catalog-showcases", "imdb-top250"] },
);

export type RecentSeriesEpisode = {
  id: string;
  serieId: string;
  titulo: string | null;
  thumbnail: string | null;
  temporada: number;
  numeroEp: number;
  dub: boolean;
  leg: boolean;
  episodioCriadoEm: Date;
  atualizadoEm: Date;
  serieTitulo: string;
  seriePoster: string | null;
  serieBackground: string | null;
  serieLogo: string | null;
  serieSinopse: string | null;
  serieAno: number | null;
  serieNota: number | null;
  serieTipo: string;
};

/**
 * Um episódio por série, deduplicado ANTES do limite final.
 *
 * A primeira etapa encontra as séries atualizadas mais recentemente. Para cada
 * uma delas, o lateral escolhe o episódio atual mais avançado por temporada,
 * número e data. Assim, um lote com centenas de episódios ocupa uma posição,
 * sem impedir que outras séries completem a vitrine.
 */
/**
 * A linha crua traz o tmdbId da série só para a deduplicação decidir qual
 * duplicata fica. Ele não sobrevive ao retorno: nenhum componente precisa dele,
 * e o que a vitrine não usa não deve chegar ao HTML.
 */
type LinhaRecente = RecentSeriesEpisode & { serieTmdbId: string | null };

export const getRecentSeriesEpisodes = unstable_cache(
  async (): Promise<RecentSeriesEpisode[]> => prisma.$queryRaw<LinhaRecente[]>(Prisma.sql`
    WITH "SeriesRecentes" AS (
      SELECT e."serieId", MAX(e."createdAt") AS "atualizadoEm"
      FROM "Episodio" e
      WHERE e."urlDub" IS NOT NULL OR e."urlLeg" IS NOT NULL
      GROUP BY e."serieId"
      ORDER BY "atualizadoEm" DESC, e."serieId" ASC
      LIMIT ${CATALOG_SHOWCASE_LIMIT * 2}
    )
    SELECT
      ep.id,
      ep."serieId",
      s."tmdbId" AS "serieTmdbId",
      ep.titulo,
      ep.thumbnail,
      ep.temporada,
      ep."numeroEp",
      (ep."urlDub" IS NOT NULL) AS dub,
      (ep."urlLeg" IS NOT NULL) AS leg,
      ep."createdAt" AS "episodioCriadoEm",
      sr."atualizadoEm",
      s.titulo AS "serieTitulo",
      s.poster AS "seriePoster",
      s.background AS "serieBackground",
      s.logo AS "serieLogo",
      s.sinopse AS "serieSinopse",
      s.ano AS "serieAno",
      s.nota AS "serieNota",
      s.tipo AS "serieTipo"
    FROM "SeriesRecentes" sr
    CROSS JOIN LATERAL (
      SELECT e.*
      FROM "Episodio" e
      WHERE e."serieId" = sr."serieId"
        AND (e."urlDub" IS NOT NULL OR e."urlLeg" IS NOT NULL)
      ORDER BY e.temporada DESC, e."numeroEp" DESC, e."createdAt" DESC, e.id ASC
      LIMIT 1
    ) ep
    INNER JOIN "Serie" s ON s.id = ep."serieId"
    ORDER BY sr."atualizadoEm" DESC, ep."serieId" ASC
  `).then((linhas) =>
    // Um episódio por série já era garantido; o que faltava era um episódio por
    // TÍTULO. Três linhas duplicadas são três `serieId` distintos, então o mesmo
    // título ocupava três das vagas da vitrine. O CTE busca o dobro do limite
    // justamente para que o colapso não deixe a prateleira curta.
    dedupeCanonical(
      linhas.map((linha) => ({ ...linha, tmdbId: linha.serieTmdbId, tipo: "serie" })),
    )
      .slice(0, CATALOG_SHOWCASE_LIMIT)
      .map(({ tmdbId, tipo, serieTmdbId, ...linha }) => linha),
  ),
  ["catalog-showcases-recent-series-v2"],
  { revalidate: 300, tags: ["catalog-showcases", "recent-episodes"] },
);
