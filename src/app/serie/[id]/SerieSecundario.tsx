import type { Serie } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  imgUrl,
  getSerie,
  getTVCredits,
  getTVRecommendations,
} from "@/lib/tmdb";
import { JsonLd } from "@/components/seo/JsonLd";
import { PeopleRow, type PeopleRowItem } from "@/components/ui/PeopleRow";
import { LandscapeRow } from "@/components/ui/LandscapeRow";

/**
 * Trabalho secundário da ficha de série, fora do caminho crítico.
 *
 * Elenco, direção/criação, o JSON-LD da série (que precisa do elenco em `actor`)
 * e os conteúdos parecidos não bloqueiam HERO + ASSISTIR + EPISÓDIOS: a página
 * renderiza a parte principal com os dados locais e deixa estes blocos chegarem
 * depois, via <Suspense>. O conteúdo (PeopleRow, recomendações, JSON-LD) é o
 * mesmo de antes — só o momento de resolução mudou.
 */

/** Elenco + direção/criação + JSON-LD da série (actor depende do elenco). */
export async function SerieCreditos({
  serie,
  genres,
  certificacao,
  canonicalUrl,
  numberOfSeasons,
  numberOfEpisodes,
}: {
  serie: Serie;
  genres: string[];
  certificacao: string | null;
  canonicalUrl: string;
  numberOfSeasons: number;
  numberOfEpisodes: number;
}) {
  const [credits, tmdbDetails] = await Promise.all([
    serie.tmdbId ? getTVCredits(serie.tmdbId) : null,
    serie.tmdbId ? getSerie(serie.tmdbId) : null,
  ]);

  const cast = (credits?.cast ?? []).slice(0, 16);

  const creativePeople = new Map<number, PeopleRowItem>();
  for (const person of tmdbDetails?.created_by ?? []) {
    creativePeople.set(person.id, { ...person, role: "Criação" });
  }
  for (const person of credits?.crew ?? []) {
    const directed = person.job === "Director" || person.jobs?.some((job) => job.job === "Director");
    if (!directed) continue;
    const current = creativePeople.get(person.id);
    creativePeople.set(person.id, {
      id: person.id,
      name: person.name,
      profile_path: person.profile_path,
      role: current ? "Criação e direção" : "Direção",
    });
  }

  // Idêntico ao schema anterior — só saiu do caminho crítico para o <Suspense>.
  const seriesSchema = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    name: serie.titulo,
    alternateName: serie.tituloOriginal || undefined,
    description: serie.sinopse || undefined,
    image: serie.poster ? imgUrl(serie.poster, "w500") : undefined,
    dateCreated: serie.ano ? String(serie.ano) : undefined,
    numberOfSeasons: numberOfSeasons || undefined,
    numberOfEpisodes: numberOfEpisodes || undefined,
    genre: genres,
    contentRating: certificacao || undefined,
    actor: cast.map((person) => ({ "@type": "Person", name: person.name })),
    aggregateRating:
      serie.nota && serie.voteCount && serie.voteCount > 0
        ? {
            "@type": "AggregateRating",
            ratingValue: serie.nota,
            bestRating: 10,
            worstRating: 0,
            ratingCount: serie.voteCount,
          }
        : undefined,
    url: canonicalUrl,
    identifier: serie.imdbId || serie.tmdbId || serie.id,
    inLanguage: "pt-BR",
  };

  return (
    <>
      <JsonLd data={seriesSchema} />
      <PeopleRow title="Criação e direção" people={[...creativePeople.values()]} />
      <PeopleRow
        title="Elenco principal"
        people={cast.map((person) => ({
          ...person,
          role: person.character ?? person.roles?.[0]?.character,
        }))}
      />
    </>
  );
}

/** "Conteúdos parecidos": recomendações do TMDB casadas com o nosso catálogo. */
export async function SerieRecomendacoes({
  serieId,
  tmdbId,
  serieTitulo,
  generoIds,
}: {
  serieId: string;
  tmdbId: string | null;
  serieTitulo: string;
  generoIds: number[];
}) {
  const SEL = {
    id: true, titulo: true, poster: true, background: true,
    logo: true, ano: true, nota: true, tipo: true,
  } as const;

  let recCards: any[] = [];

  const tmdbRecs = tmdbId ? await getTVRecommendations(tmdbId) : null;
  if (tmdbRecs?.results?.length) {
    const tmdbIds = tmdbRecs.results.map((r: any) => String(r.id));
    const dbRecs = await prisma.serie.findMany({ where: { tmdbId: { in: tmdbIds } }, select: SEL });
    recCards = dbRecs.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  // Fallback: séries do mesmo gênero.
  if (!recCards.length) {
    const fallback = await prisma.serie.findMany({
      where: { id: { not: serieId }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      select: SEL,
    });
    recCards = fallback.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  if (!recCards.length) return null;

  return (
    <div className="pt-4">
      <LandscapeRow titulo={`Conteúdos parecidos com ${serieTitulo}`} items={recCards} />
    </div>
  );
}
