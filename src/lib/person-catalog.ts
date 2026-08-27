import { prisma } from "@/lib/prisma";
import { getPerson, type TmdbPersonCredit } from "@/lib/tmdb";

export type PersonCatalogKind = "filme" | "serie" | "anime" | "desenho";

export interface PersonCatalogItem {
  id: string;
  tmdbId: string;
  tipo: PersonCatalogKind;
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
  audioDub: boolean;
  audioLeg: boolean;
  papeis: string[];
}

export interface PersonCatalogResult {
  pessoa: {
    id: number;
    nome: string;
    biografia: string | null;
    nascimento: string | null;
    falecimento: string | null;
    localNascimento: string | null;
    foto: string | null;
    areaConhecida: string | null;
  };
  filmes: PersonCatalogItem[];
  series: PersonCatalogItem[];
  total: number;
}

type CreditInfo = {
  papeis: Set<string>;
  popularidade: number;
};

const JOB_LABELS: Record<string, string> = {
  Director: "Direção",
  Creator: "Criação",
  Writer: "Roteiro",
  Screenplay: "Roteiro",
  Story: "História",
  Producer: "Produção",
  "Executive Producer": "Produção executiva",
  "Director of Photography": "Direção de fotografia",
  Editor: "Montagem",
  Composer: "Trilha sonora",
};

function normalizeSeriesType(tipo: string): PersonCatalogKind {
  return tipo === "anime" || tipo === "desenho" ? tipo : "serie";
}

function addCredit(
  map: Map<string, CreditInfo>,
  credit: TmdbPersonCredit,
  role: string,
) {
  if (!credit.id || (credit.media_type !== "movie" && credit.media_type !== "tv")) return;
  const key = `${credit.media_type}:${credit.id}`;
  const current = map.get(key) ?? { papeis: new Set<string>(), popularidade: 0 };
  current.papeis.add(role);
  current.popularidade = Math.max(current.popularidade, credit.popularity ?? 0);
  map.set(key, current);
}

function dedupeBest<T extends { tmdbId: string | null }>(
  rows: T[],
  score: (row: T) => number,
): Array<T & { tmdbId: string }> {
  const selected = new Map<string, T & { tmdbId: string }>();
  for (const row of rows) {
    if (!row.tmdbId) continue;
    const normalized = row as T & { tmdbId: string };
    const current = selected.get(row.tmdbId);
    if (!current || score(row) > score(current)) selected.set(row.tmdbId, normalized);
  }
  return [...selected.values()];
}

function sortCatalog(a: PersonCatalogItem, b: PersonCatalogItem) {
  return (b.ano ?? 0) - (a.ano ?? 0) || (b.nota ?? 0) - (a.nota ?? 0) || a.titulo.localeCompare(b.titulo, "pt-BR");
}

export async function getPersonCatalog(personId: number): Promise<PersonCatalogResult | null> {
  const person = await getPerson(personId);
  if (!person) return null;

  const credits = new Map<string, CreditInfo>();
  for (const credit of person.combined_credits?.cast ?? []) {
    const role = credit.character ? `Atuação como ${credit.character}` : "Atuação";
    addCredit(credits, credit, role);
  }
  for (const credit of person.combined_credits?.crew ?? []) {
    const role = JOB_LABELS[credit.job ?? ""] ?? credit.job ?? credit.department ?? "Equipe";
    addCredit(credits, credit, role);
  }

  const movieIds = [...credits.keys()]
    .filter((key) => key.startsWith("movie:"))
    .map((key) => key.slice(6));
  const tvIds = [...credits.keys()]
    .filter((key) => key.startsWith("tv:"))
    .map((key) => key.slice(3));

  const [movieRows, seriesRows] = await Promise.all([
    movieIds.length
      ? prisma.filme.findMany({
          where: {
            tmdbId: { in: movieIds },
            OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
          },
          select: {
            id: true,
            tmdbId: true,
            titulo: true,
            poster: true,
            background: true, logo: true,
            ano: true,
            nota: true,
            urlDub: true,
            urlLeg: true,
          },
        })
      : Promise.resolve([]),
    tvIds.length
      ? prisma.serie.findMany({
          where: {
            tmdbId: { in: tvIds },
            episodios: {
              some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
            },
          },
          select: {
            id: true,
            tmdbId: true,
            titulo: true,
            poster: true,
            background: true, logo: true,
            ano: true,
            nota: true,
            tipo: true,
            _count: { select: { episodios: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const filmes = dedupeBest(
    movieRows,
    (row) => Number(Boolean(row.urlDub)) * 4 + Number(Boolean(row.urlLeg)) * 3 + Number(Boolean(row.background)) * 2 + Number(Boolean(row.poster)),
  ).map<PersonCatalogItem>((row) => ({
    id: row.id,
    tmdbId: row.tmdbId,
    tipo: "filme",
    titulo: row.titulo,
    poster: row.poster,
    background: row.background,
    ano: row.ano,
    nota: row.nota,
    audioDub: Boolean(row.urlDub),
    audioLeg: Boolean(row.urlLeg),
    papeis: [...(credits.get(`movie:${row.tmdbId}`)?.papeis ?? [])],
  })).sort(sortCatalog);

  const series = dedupeBest(
    seriesRows,
    (row) => row._count.episodios * 10 + Number(Boolean(row.background)) * 2 + Number(Boolean(row.poster)),
  ).map<PersonCatalogItem>((row) => ({
    id: row.id,
    tmdbId: row.tmdbId,
    tipo: normalizeSeriesType(row.tipo),
    titulo: row.titulo,
    poster: row.poster,
    background: row.background,
    ano: row.ano,
    nota: row.nota,
    audioDub: false,
    audioLeg: false,
    papeis: [...(credits.get(`tv:${row.tmdbId}`)?.papeis ?? [])],
  })).sort(sortCatalog);

  return {
    pessoa: {
      id: person.id,
      nome: person.name,
      biografia: person.biography?.trim() || null,
      nascimento: person.birthday ?? null,
      falecimento: person.deathday ?? null,
      localNascimento: person.place_of_birth ?? null,
      foto: person.profile_path ?? null,
      areaConhecida: person.known_for_department ?? null,
    },
    filmes,
    series,
    total: filmes.length + series.length,
  };
}
